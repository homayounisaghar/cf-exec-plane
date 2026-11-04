FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0
COPY --chown=node:node server.mjs package.json ./
USER node
EXPOSE 8080
CMD ["node","server.mjs"]
