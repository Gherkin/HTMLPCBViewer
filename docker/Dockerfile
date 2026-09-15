FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/index.html /usr/share/nginx/html/index.html

# Shared viewer shell — build with: python generate.py --build-viewer
# Then commit docker/viewer.html and rebuild the Docker image.
COPY docker/viewer.html /usr/share/nginx/html/viewer/index.html
