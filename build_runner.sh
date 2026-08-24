#!/usr/bin/env bash

# ==============================================================================
# build_runner.sh - Automated Docker Sandbox Runner Image Builder
# Builds: interviewai-runner:latest
# ==============================================================================

set -e

IMAGE_TAG="interviewai-runner:latest"
DOCKERFILE_PATH="docker/Dockerfile"

# Terminal Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}======================================================${NC}"
echo -e "${BLUE}   InterviewAI - Docker Sandbox Runner Builder        ${NC}"
echo -e "${BLUE}======================================================${NC}"

# Check Docker CLI installation
if ! command -v docker >/dev/null 2>&1; then
    echo -e "${RED}[ERROR] Docker is not installed or not in PATH.${NC}"
    echo "Please install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    exit 1
fi

# Locate Dockerfile
if [ ! -f "$DOCKERFILE_PATH" ]; then
    if [ -f "../$DOCKERFILE_PATH" ]; then
        DOCKERFILE_PATH="../$DOCKERFILE_PATH"
    else
        echo -e "${RED}[ERROR] Dockerfile not found at $DOCKERFILE_PATH${NC}"
        exit 1
    fi
fi

echo -e "${YELLOW}Building Docker sandbox image: ${IMAGE_TAG}...${NC}"
echo -e "Using Dockerfile: ${DOCKERFILE_PATH}"

docker build -t "$IMAGE_TAG" -f "$DOCKERFILE_PATH" .

echo -e "\n${GREEN}✔ Docker runner image successfully built:${NC} ${IMAGE_TAG}"
