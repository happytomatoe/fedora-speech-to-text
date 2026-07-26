FROM python:3.13-slim

WORKDIR /app

# Install uv for package management
RUN pip install uv

# Copy project files
COPY pyproject.toml uv.lock ./

# Install dependencies
RUN uv sync --frozen --no-dev

# Copy source and tests
COPY src/ src/
COPY tests/ tests/

CMD ["uv", "run", "pytest", "-n", "auto"]
