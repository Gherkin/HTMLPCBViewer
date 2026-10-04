FROM --platform=$BUILDPLATFORM python:3.12-alpine AS build

# Build the shared viewer shell from web/ so it always matches the sources.
# The output is plain HTML, so this stage runs natively, not under emulation.
COPY web/ /src/web/
COPY generate.py /src/
RUN python /src/generate.py --build-viewer -o /out/viewer.html

FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/index.html /usr/share/nginx/html/index.html
COPY --from=build /out/viewer.html /usr/share/nginx/html/viewer/index.html
