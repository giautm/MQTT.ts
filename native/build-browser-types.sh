#!/bin/bash

# Copy the source.
rm -rf src
mkdir -p src/browser
cp -r ../client src
cp -r ../lib src
cp -r ../packets src
cp ./index.ts src/browser
cp ./browser_client.ts src/browser
cp ./UTF8Decoder.ts src/browser
cp ./UTF8Encoder.ts src/browser

# Strip off the .ts extensions from the imports.
find src -type f -print | while read f; do
  echo $f
  sed -i "" -e "s/\\.ts';$/';/" $f
done

find src -type f -print | while read f; do
  echo $f
  sed -i "" -e "s/https\\:\\/\\/dev\\.jspm\\.io\\///" $f
done

# Generate the .d.ts file.
./node_modules/.bin/tsc \
  --lib es6,dom,esnext.asynciterable \
  --target es6 \
  --declaration \
  --emitDeclarationOnly \
  --moduleResolution node \
  --out index.js \
  src/browser/index.ts

# Add a declaration for the package.
echo "declare module \"@jdiamond/mqtt-native\" {
    export * from \"browser/index\";
}" >> index.d.ts
