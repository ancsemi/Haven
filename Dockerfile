# Use the official Node.js LTS Alpine image for a lightweight footprint
FROM node:20-alpine

# Install OpenSSL (Required by Haven to auto-generate self-signed certs for HTTPS/Voice)
RUN apk update && apk add --no-cache openssl

# Set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json (if available)
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Set environment variables
ENV PORT=3000
# Tell Haven to store its database, .env config, and certificates here
ENV HAVEN_DATA_DIR=/data 

# Create the persistent data directory and ensure the 'node' user owns it
RUN mkdir -p /data && chown -R node:node /app /data

# Run the container as the non-root 'node' user for better security
USER node

# Expose the default Haven port
EXPOSE 3000

# Create a volume mount point so data survives container restarts
VOLUME ["/data"]

# Start the Haven server
CMD ["node", "server.js"]