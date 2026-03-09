FROM eclipse-temurin:21-jdk

# Install Node.js
RUN apt-get update && apt-get install -y curl gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Install Python
RUN apt-get install -y python3 python3-pip

# Install Go
RUN apt-get install -y golang

# Install Rust
RUN apt-get install -y rustc cargo

# Install g++
RUN apt-get install -y g++

# Install Kotlin
RUN apt-get install -y wget unzip && \
    wget -q https://github.com/JetBrains/kotlin/releases/download/v2.0.21/kotlin-compiler-2.0.21.zip -O /tmp/kotlin.zip && \
    unzip -q /tmp/kotlin.zip -d /opt && \
    rm /tmp/kotlin.zip
ENV PATH="/opt/kotlinc/bin:$PATH"

# App
WORKDIR /app
COPY package.json .
COPY server.js .
COPY index.html .
COPY logo.png .

RUN mkdir -p /data
ENV DATA_DIR=/data

EXPOSE 4321
CMD ["node", "server.js"]
