FROM alpine:3.18

RUN apk add --no-cache graphviz ttf-dejavu && \
    chmod -R a+rw /var/cache/fontconfig

COPY docker/graphviz.sh /dot/graphviz.sh

WORKDIR /data

ENTRYPOINT ["/dot/graphviz.sh"]
