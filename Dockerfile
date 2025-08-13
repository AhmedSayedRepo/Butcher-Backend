# Deploy-ready Dockerfile (optional on Railway; Railway can auto-build from Node)
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 8080
CMD ["npm", "start"]
