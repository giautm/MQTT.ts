import { QoS } from '../types.ts';
import {
  encode,
  decode,
  AnyPacket,
  AnyPacketWithLength,
  ConnackPacket,
  PublishPacket,
  PubackPacket,
  PubrecPacket,
  PubrelPacket,
  PubcompPacket,
  SubscribePacket,
  SubackPacket,
  UnsubscribePacket,
  UnsubackPacket,
} from '../packets/mod.ts';
import { UTF8Encoder, UTF8Decoder } from '../packets/utf8.ts';

type URLFactory = URL | string | (() => URL | string | void);
type ClientIdFactory = string | (() => string);

export type BaseClientOptions = {
  url?: URLFactory;
  clientId?: ClientIdFactory;
  clientIdPrefix?: string;
  clean?: boolean;
  keepAlive?: number;
  username?: string;
  password?: string;
  connectTimeout?: number;
  connect?: boolean | RetryOptions;
  reconnect?: boolean | RetryOptions;
  logger?: (msg: string, ...args: unknown[]) => void;
};

export type RetryOptions = {
  retries?: number;
  minDelay?: number;
  maxDelay?: number;
  factor?: number;
  random?: boolean;
};

export type PublishOptions = {
  dup?: boolean;
  qos?: QoS;
  retain?: boolean;
};

export type SubscriptionOption = {
  topic: string;
  qos?: QoS;
};

export type Subscription = {
  topic: string;
  qos: QoS;
};

type ConnectionStates =
  | 'offline'
  | 'connecting'
  | 'waiting-for-connack'
  | 'connected'
  | 'disconnecting'
  | 'disconnected';

const packetIdLimit = 2 ** 16;

const defaultPorts: { [protocol: string]: number } = {
  mqtt: 1883,
  mqtts: 8883,
  ws: 80,
  wss: 443,
};

const defaultClientIdPrefix = 'mqttts';
const defaultKeepAlive = 60;
const defaultConnectTimeout = 10 * 1000;
const defaultConnectOptions = {
  retries: Infinity,
  minDelay: 1000,
  maxDelay: 2000,
  factor: 1.1,
  random: false,
};
const defaultReconnectOptions = {
  retries: Infinity,
  minDelay: 1000,
  maxDelay: 60000,
  factor: 1.1,
  random: true,
};

export abstract class BaseClient<OptionsType extends BaseClientOptions> {
  options: OptionsType;
  url?: URL;
  clientId: string;
  keepAlive: number;
  connectionState: ConnectionStates = 'offline';
  everConnected: boolean = false;
  disconnectRequested: boolean = false;
  reconnectAttempt: number = 0;
  subscriptions: Subscription[] = [];

  private lastPacketId: number = 0;
  private lastPacketTime: Date | undefined;

  private buffer: Uint8Array | null = null;

  queuedPackets: AnyPacket[] = [];

  unacknowledgedConnect?: Deferred<ConnackPacket, void>;

  private unacknowledgedPublishes = new Map<
    number,
    Deferred<PubackPacket, PublishPacket>
  >();
  private unacknowledgedSubscribes = new Map<
    number,
    Deferred<SubackPacket, SubscribePacket>
  >();
  private unacknowledgedUnsubscribes = new Map<
    number,
    Deferred<UnsubackPacket, UnsubscribePacket>
  >();

  eventListeners: Map<string, Function[]> = new Map();

  private timers: {
    [key: string]: any | undefined;
  } = {};

  log: (msg: string, ...args: unknown[]) => void;

  public constructor(options?: OptionsType) {
    this.options = options || <OptionsType>{};
    this.clientId = this.generateClientId();
    this.keepAlive =
      typeof this.options.keepAlive === 'number'
        ? this.options.keepAlive
        : defaultKeepAlive;
    this.log = this.options.logger || (() => {});
  }

  // Public methods

  public async connect(): Promise<ConnackPacket> {
    switch (this.connectionState) {
      case 'offline':
      case 'disconnected':
        break;
      default:
        throw new Error(
          `should not be connecting in ${this.connectionState} state`
        );
    }

    this.disconnectRequested = false;

    const deferred = new Deferred<ConnackPacket, void>();

    this.unacknowledgedConnect = deferred;

    this.openConnection();

    return deferred.promise;
  }

  public async publish(
    topic: string,
    payload: any,
    options?: PublishOptions
  ): Promise<PubackPacket | void> {
    const dup = (options && options.dup) || false;
    const qos = (options && options.qos) || 0;
    const retain = (options && options.retain) || false;
    const id = qos > 0 ? this.nextPacketId() : 0;

    const packet: PublishPacket = {
      type: 'publish',
      dup,
      qos,
      retain,
      topic,
      payload,
      id,
    };

    let result = undefined;

    if (qos > 0) {
      const deferred = new Deferred<PubackPacket, PublishPacket>(packet);

      this.unacknowledgedPublishes.set(id, deferred);

      result = deferred.promise;
    }

    await this.queue(packet);

    return result;
  }

  public async subscribe(
    topic: SubscriptionOption | string | (SubscriptionOption | string)[],
    qos?: QoS
  ): Promise<SubackPacket> {
    switch (this.connectionState) {
      case 'connected':
        break;
      default:
        throw new Error(
          `should not be subscribing in ${this.connectionState} state`
        );
    }

    const arr = Array.isArray(topic) ? topic : [topic];

    const subs = arr.map((sub) => {
      return typeof sub === 'object'
        ? { topic: sub.topic, qos: sub.qos || qos || <QoS>0 }
        : { topic: sub, qos: qos || <QoS>0 };
    });

    for (const sub of subs) {
      // Replace any matching subscription so we don't resubscribe to it
      // multiple times on reconnect. This matches what the broker is supposed
      // to do when it receives a subscribe packet containing a topic filter
      // matching an existing subscription.
      this.subscriptions = this.subscriptions.filter(
        (old) => old.topic !== sub.topic
      );

      this.subscriptions.push(sub);
    }

    const subscribePacket: SubscribePacket = {
      type: 'subscribe',
      id: this.nextPacketId(),
      subscriptions: subs,
    };

    const deferred = new Deferred<SubackPacket, SubscribePacket>(
      subscribePacket
    );

    this.unacknowledgedSubscribes.set(subscribePacket.id, deferred);

    await this.send(subscribePacket);

    return deferred.promise;
  }

  public async unsubscribe(topic: string): Promise<UnsubackPacket> {
    // TODO: support array of topics

    switch (this.connectionState) {
      case 'connected':
        break;
      default:
        throw new Error(
          `should not be unsubscribing in ${this.connectionState} state`
        );
    }

    this.subscriptions = this.subscriptions.filter(
      (sub) => sub.topic !== topic
    );

    const unsubscribePacket: UnsubscribePacket = {
      type: 'unsubscribe',
      id: this.nextPacketId(),
      topics: [topic],
    };

    const deferred = new Deferred<UnsubackPacket, UnsubscribePacket>(
      unsubscribePacket
    );

    this.unacknowledgedUnsubscribes.set(unsubscribePacket.id, deferred);

    await this.send(unsubscribePacket);

    return deferred.promise;
  }

  public async disconnect(): Promise<void> {
    switch (this.connectionState) {
      case 'connected':
        await this.doDisconnect();
        break;
      case 'connecting':
      case 'waiting-for-connack':
        this.disconnectRequested = true;
        break;
      case 'offline':
        this.changeState('disconnected');
        this.stopTimers();
        break;
      default:
        throw new Error(
          `should not be disconnecting in ${this.connectionState} state`
        );
    }
  }

  private async doDisconnect() {
    this.changeState('disconnecting');
    this.stopTimers();
    await this.send({ type: 'disconnect' });
    await this.close();
  }

  // Connection methods implemented by subclasses

  protected abstract getDefaultURL(): URL | string;

  protected abstract validateURL(url: URL): void;

  protected abstract async open(url: URL): Promise<void>;

  protected abstract async write(bytes: Uint8Array): Promise<void>;

  protected abstract async close(): Promise<void>;

  protected encode(packet: AnyPacket, utf8Encoder?: UTF8Encoder): Uint8Array {
    return encode(packet, utf8Encoder);
  }

  protected decode(
    bytes: Uint8Array,
    utf8Decoder?: UTF8Decoder
  ): AnyPacketWithLength | null {
    return decode(bytes, utf8Decoder);
  }

  // This gets called from connect and when reconnecting.
  protected async openConnection() {
    try {
      this.changeState('connecting');

      this.url = this.getURL();

      this.log(`opening connection to ${this.url}`);

      await this.open(this.url);

      await this.send({
        type: 'connect',
        clientId: this.clientId,
        username: this.options.username,
        password: this.options.password,
        clean: this.options.clean !== false,
        keepAlive: this.keepAlive,
      });

      this.changeState('waiting-for-connack');

      this.startConnectTimer();
    } catch (err) {
      this.changeState('offline');

      if (!this.startReconnectTimer()) {
        this.notifyConnectRejected(new Error('connection failed'));
      }
    }
  }

  // This gets by subclasses when the connection is unexpectedly closed.
  protected connectionClosed() {
    this.log('connectionClosed');

    switch (this.connectionState) {
      case 'disconnecting':
        this.changeState('disconnected');
        break;
      default:
        this.changeState('offline');
        this.reconnectAttempt = 0;
        this.startReconnectTimer();
        break;
    }

    this.stopKeepAliveTimer();
  }

  protected connectionError(error: any) {
    // TODO: decide what to do with this
    this.log('connectionError', error);
  }

  protected bytesReceived(bytes: Uint8Array) {
    this.log('bytes received', bytes);

    this.emit('bytesreceived', bytes);

    let buffer: Uint8Array | null = bytes;

    const oldBuffer = this.buffer;

    if (oldBuffer) {
      const newBuffer = new Uint8Array(oldBuffer.length + bytes.length);

      newBuffer.set(oldBuffer);
      newBuffer.set(bytes, oldBuffer.length);

      buffer = newBuffer;
    } else {
      buffer = bytes;
    }

    do {
      const packet = this.decode(buffer);

      if (!packet) {
        break;
      }

      this.log(`received ${packet.type} packet`, packet);

      this.packetReceived(packet);

      if (packet.length < buffer.length) {
        buffer = buffer.slice(packet.length);
      } else {
        buffer = null;
      }
    } while (buffer);

    this.buffer = buffer;
  }

  protected packetReceived(packet: AnyPacket) {
    this.emit('packetreceive', packet);

    switch (packet.type) {
      case 'connack':
        this.handleConnack(packet);
        break;
      case 'publish':
        this.handlePublish(packet);
        break;
      case 'puback':
        this.handlePuback(packet);
        break;
      case 'pubrec':
        this.handlePubrec(packet);
        break;
      case 'pubrel':
        this.handlePubrel(packet);
        break;
      case 'pubcomp':
        this.handlePubcomp(packet);
        break;
      case 'suback':
        this.handleSuback(packet);
        break;
      case 'unsuback':
        this.handleUnsuback(packet);
        break;
    }
  }

  protected protocolViolation(msg: string) {
    this.log('protocolViolation', msg);
  }

  protected handleConnack(packet: ConnackPacket) {
    switch (this.connectionState) {
      case 'waiting-for-connack':
        break;
      default:
        throw new Error(
          `should not be receiving connack packets in ${this.connectionState} state`
        );
    }

    this.changeState('connected');

    this.everConnected = true;

    if (this.unacknowledgedConnect) {
      this.log('resolving initial connect');

      this.unacknowledgedConnect.resolve(packet);
    }

    this.sendSubscriptions();
    // TODO: resend unacknowledged publish and pubcomp packets
    // TODO: flush publishes queued while not connected
    this.flushQueuedPackets();
    this.stopConnectTimer();
    this.startKeepAliveTimer();
  }

  protected handlePublish(packet: PublishPacket) {
    this.emit('message', packet.topic, packet.payload, packet);

    if (packet.qos === 1) {
      if (typeof packet.id !== 'number' || packet.id < 1) {
        return this.protocolViolation(
          'publish packet with qos 1 is missing id'
        );
      }

      this.send({
        type: 'puback',
        id: packet.id,
      });
    } else if (packet.qos === 2) {
      if (typeof packet.id !== 'number' || packet.id < 1) {
        return this.protocolViolation(
          'publish packet with qos 2 is missing id'
        );
      }

      this.send({
        type: 'pubrec',
        id: packet.id,
      });
    }
  }

  protected handlePuback(packet: PubackPacket) {
    const deferred = this.unacknowledgedPublishes.get(packet.id);

    if (deferred) {
      this.unacknowledgedPublishes.delete(packet.id);
      deferred.resolve(packet);
    } else {
      this.log(`received puback packet with unrecognized id ${packet.id}`);
    }
  }

  protected handlePubrec(packet: PubrecPacket) {
    // TODO: mark message as received
    this.send({
      type: 'pubrel',
      id: packet.id,
    });
  }

  protected handlePubrel(packet: PubrelPacket) {
    // TODO: mark message as released
    this.send({
      type: 'pubcomp',
      id: packet.id,
    });
  }

  protected handlePubcomp(_packet: PubcompPacket) {
    // TODO: mark message as completely acknowledged
  }

  protected handleSuback(packet: SubackPacket) {
    const deferred = this.unacknowledgedSubscribes.get(packet.id);

    // TODO: verify returnCodes length matches subscriptions.length

    if (deferred) {
      this.unacknowledgedSubscribes.delete(packet.id);
      deferred.resolve(packet);
    } else {
      this.log(`received suback packet with unrecognized id ${packet.id}`);
    }
  }

  protected handleUnsuback(packet: UnsubackPacket) {
    const deferred = this.unacknowledgedUnsubscribes.get(packet.id);

    if (deferred) {
      this.unacknowledgedUnsubscribes.delete(packet.id);
      deferred.resolve(packet);
    } else {
      this.log(`received unsuback packet with unrecognized id ${packet.id}`);
    }
  }

  protected startConnectTimer() {
    this.startTimer(
      'connect',
      () => {
        this.connectTimedOut();
      },
      this.options.connectTimeout || defaultConnectTimeout
    );
  }

  protected connectTimedOut() {
    switch (this.connectionState) {
      case 'waiting-for-connack':
        break;
      default:
        throw new Error(
          `connect timer should time out in ${this.connectionState} state`
        );
    }

    this.changeState('offline');

    this.close();

    this.notifyConnectRejected(new Error('connect timed out'));

    this.reconnectAttempt = 0;

    this.startReconnectTimer();
  }

  protected notifyConnectRejected(err: Error) {
    if (this.unacknowledgedConnect) {
      this.log('rejecting initial connect');

      this.unacknowledgedConnect.reject(err);
    }
  }

  protected stopConnectTimer() {
    if (this.timerExists('connect')) {
      this.stopTimer('connect');
    }
  }

  protected startReconnectTimer() {
    const options = this.options;

    let reconnectOptions;
    let defaultOptions;

    if (!this.everConnected) {
      reconnectOptions = options.connect || {};
      defaultOptions = defaultConnectOptions;
    } else {
      reconnectOptions = options.reconnect || {};
      defaultOptions = defaultReconnectOptions;
    }

    if (reconnectOptions === false) {
      return;
    } else if (reconnectOptions === true) {
      reconnectOptions = {};
    }

    const attempt = this.reconnectAttempt;
    const maxAttempts = reconnectOptions.retries ?? defaultOptions.retries;

    if (attempt >= maxAttempts) {
      return false;
    }

    // I started off using the formula in this article
    // https://dthain.blogspot.com/2009/02/exponential-backoff-in-distributed.html
    // but modified the random part so that the delay will be strictly
    // increasing.
    const min = reconnectOptions.minDelay ?? defaultOptions.minDelay;
    const max = reconnectOptions.maxDelay ?? defaultOptions.maxDelay;
    const factor = reconnectOptions.factor ?? defaultOptions.factor;
    const random = reconnectOptions.random ?? defaultOptions.random;

    // The old way:
    // const randomness = 1 + (random ? Math.random() : 0);
    // const delay = Math.floor(Math.min(randomness * min * Math.pow(factor, attempt), max));

    // The new way:
    const thisDelay = min * Math.pow(factor, attempt);
    const nextDelay = min * Math.pow(factor, attempt + 1);
    const diff = nextDelay - thisDelay;
    const randomness = random ? diff * Math.random() : 0;
    const delay = Math.floor(Math.min(thisDelay + randomness, max));

    this.log(`reconnect attempt ${attempt + 1} in ${delay}ms`);

    this.startTimer(
      'reconnect',
      () => {
        this.reconnectAttempt++;
        this.openConnection();
      },
      delay
    );

    return true;
  }

  protected stopReconnectTimer() {
    if (this.timerExists('reconnect')) {
      this.stopTimer('reconnect');
    }
  }

  protected startKeepAliveTimer() {
    if (!this.keepAlive) {
      return;
    }

    // This method doesn't get called until after sending the connect packet
    // so this.lastPacketTime should have a value.
    const elapsed = Date.now() - this.lastPacketTime!.getTime();
    const timeout = this.keepAlive * 1000 - elapsed;

    this.startTimer('keepAlive', () => this.sendKeepAlive(), timeout);
  }

  protected stopKeepAliveTimer() {
    if (this.timerExists('keepAlive')) {
      this.stopTimer('keepAlive');
    }
  }

  protected async sendKeepAlive() {
    if (this.connectionState === 'connected') {
      const elapsed = Date.now() - this.lastPacketTime!.getTime();
      const timeout = this.keepAlive * 1000;

      if (elapsed >= timeout) {
        await this.send({
          type: 'pingreq',
        });
      }

      this.startKeepAliveTimer();
    } else {
      this.log('keepAliveTimer should have been cancelled');
    }
  }

  protected stopTimers() {
    this.stopConnectTimer();
    this.stopReconnectTimer();
    this.stopKeepAliveTimer();
  }

  protected startTimer(
    name: string,
    cb: (...args: unknown[]) => void,
    delay: number
  ) {
    if (this.timerExists(name)) {
      this.log(`timer ${name} already exists`);

      this.stopTimer(name);
    }

    this.log(`starting timer ${name} for ${delay}ms`);

    this.timers[name] = setTimeout(() => {
      delete this.timers[name];

      this.log(`invoking timer ${name} callback`);

      cb();
    }, delay);
  }

  protected stopTimer(name: string) {
    if (!this.timerExists(name)) {
      this.log(`no timer ${name} to stop`);

      return;
    }

    this.log(`stopping timer ${name}`);

    const id = this.timers[name];

    if (id) {
      clearTimeout(id);

      delete this.timers[name];
    }
  }

  protected timerExists(name: string) {
    return !!this.timers[name];
  }

  protected async sendSubscriptions() {
    // Only qos 0 subscriptions.
    const subs = this.subscriptions.filter((sub) => sub.qos === 0);

    if (subs.length > 0) {
      await this.send({
        type: 'subscribe',
        id: this.nextPacketId(),
        subscriptions: subs,
      });
    }
  }

  // Utility methods

  protected changeState(newState: ConnectionStates) {
    const oldState = this.connectionState;

    this.connectionState = newState;

    this.log(`connectionState: ${oldState} -> ${newState}`);

    this.emit('statechange', { from: oldState, to: newState });

    this.emit(newState);
  }

  protected generateClientId() {
    let clientId;

    if (typeof this.options.clientId === 'string') {
      clientId = this.options.clientId;
    } else if (typeof this.options.clientId === 'function') {
      clientId = this.options.clientId();
    } else {
      const prefix = this.options.clientIdPrefix || defaultClientIdPrefix;
      const suffix = Math.random().toString(36).slice(2);

      clientId = `${prefix}-${suffix}`;
    }

    return clientId;
  }

  private getURL(): URL {
    let url: URL | string | void =
      typeof this.options.url === 'function'
        ? this.options.url()
        : this.options.url;

    if (!url) {
      url = this.getDefaultURL();
    }

    if (typeof url === 'string') {
      url = this.parseURL(url);
    }

    const protocol = url.protocol.slice(0, -1);

    if (!url.port) {
      url.port = defaultPorts[protocol].toString();
    }

    this.validateURL(url);

    return url;
  }

  protected parseURL(url: string) {
    let parsed = new URL(url);

    // When Deno and browsers parse "mqtt:" URLs, they return "//host:port/path"
    // in the `pathname` property and leave `host`, `hostname`, and `port`
    // blank. This works around that by re-parsing as an "http:" URL and then
    // changing the protocol back to "mqtt:". Node.js doesn't behave like this.
    if (!parsed.hostname && parsed.pathname.startsWith('//')) {
      const protocol = parsed.protocol;
      parsed = new URL(url.replace(protocol, 'http:'));
      parsed.protocol = protocol;
    }

    return parsed;
  }

  protected nextPacketId() {
    this.lastPacketId = (this.lastPacketId + 1) % packetIdLimit;

    // Don't allow packet id to be 0.
    if (!this.lastPacketId) {
      this.lastPacketId = 1;
    }

    return this.lastPacketId;
  }

  protected async queue(packet: AnyPacket) {
    if (this.connectionState !== 'connected') {
      this.log(`queueing ${packet.type} packet`);

      this.queuedPackets.push(packet);
    } else {
      return this.send(packet);
    }
  }

  protected async flushQueuedPackets() {
    for (const packet of this.queuedPackets) {
      await this.send(packet);
    }

    this.queuedPackets = [];

    if (this.disconnectRequested) {
      await this.doDisconnect();
    }
  }

  protected async send(packet: AnyPacket) {
    this.log(`sending ${packet.type} packet`, packet);

    this.emit('packetsend', packet);

    const bytes = this.encode(packet);

    this.emit('bytessent', bytes);

    await this.write(bytes);

    this.lastPacketTime = new Date();
  }

  public on(eventName: string, listener: Function) {
    let listeners = this.eventListeners.get(eventName);

    if (!listeners) {
      listeners = [];
      this.eventListeners.set(eventName, listeners);
    }

    listeners.push(listener);
  }

  public off(eventName: string, listener: Function) {
    const listeners = this.eventListeners.get(eventName);

    if (listeners) {
      this.eventListeners.set(
        eventName,
        listeners.filter((l) => l !== listener)
      );
    }
  }

  protected emit(eventName: string, ...args: unknown[]) {
    const listeners = this.eventListeners.get(eventName);

    if (listeners) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }
}

class Deferred<ResolveType, DataType> {
  promise: Promise<ResolveType>;
  resolve!: (val: ResolveType) => void;
  reject!: (err: Error) => void;
  data?: DataType;

  constructor(data?: DataType) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.data = data;
  }
}
