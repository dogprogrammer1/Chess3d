FROM runpod/pytorch:1.0.3-cu1281-torch291-ubuntu2404

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/workspace/chess3d/ai

WORKDIR /workspace/chess3d
COPY ai /workspace/chess3d/ai
RUN python -m pip install --no-cache-dir "numpy>=2,<3"

CMD ["bash"]
