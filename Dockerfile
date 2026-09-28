# Use official lightweight Node.js image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /usr/src/app

# Copy package files first for cached dependency installation
COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy all remaining source files
COPY . .

# Expose port 3000
EXPOSE 3000

# Start the application
CMD ["npm", "start"]