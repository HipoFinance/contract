#!/usr/bin/env sh

if [ ! -d "img" ]; then
    mkdir img
fi

for file in *.dot
do
    echo "Generating image from $file"
    dot -Tsvg $file -o img/${file%.*}.svg
done
