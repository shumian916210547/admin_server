FROM node:20-alpine AS runtime

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "app.js"]
