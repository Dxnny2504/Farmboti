FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
ENV NODE_ENV=production
ENV DATA_PATH=/data/farmboti.sqlite
EXPOSE 8080
CMD ["npm", "start"]
