# ==============================================================================
# InterviewAI Sandboxed Code Runner Dockerfile
# Lightweight, secure runtime for untrusted candidate code execution
# ==============================================================================

FROM node:20-alpine

# Install Python 3 and runtime essentials
RUN apk add --no-cache \
    python3 \
    py3-pip \
    bash \
    coreutils \
    tzdata

# Create an unprivileged non-root user 'runner' with restricted permissions
RUN addgroup -g 1001 runnergroup && \
    adduser -D -u 1001 -G runnergroup -s /bin/sh runner

# Create isolated working directory with restricted permissions
WORKDIR /home/runner/sandbox

# Secure workdir ownership
RUN chown -R runner:runnergroup /home/runner/sandbox && \
    chmod 755 /home/runner/sandbox

# Switch to non-root runner user to prevent privilege escalation
USER runner

# Set environment
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Default command
CMD ["sh"]
