"""Local-only HTTP service for checkpoint-backed chess grounding inference."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from typing import Any, Mapping, Protocol
from urllib.parse import urlparse


MAX_REQUEST_BYTES = 1_000_000


class Predictor(Protocol):
    def metadata(self) -> dict[str, Any]: ...
    def predict(self, payload: Mapping[str, Any]) -> dict[str, Any]: ...


def create_predictor(model_path: str, device: str) -> Predictor:
    if Path(model_path).suffix.lower() == ".onnx":
        from .onnx_inference import OnnxGroundingPredictor
        return OnnxGroundingPredictor(model_path, device)
    from .inference import GroundingPredictor
    return GroundingPredictor(model_path, device)


def _local_origin(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    return value if parsed.scheme in ("http", "https") and parsed.hostname in ("127.0.0.1", "localhost", "::1") else None


class GroundingRequestHandler(BaseHTTPRequestHandler):
    predictor: Predictor

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def _headers(self, status: int, content_length: int = 0) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Cache-Control", "no-store")
        origin = _local_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self._headers(status, len(body))
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._headers(204)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._json(404, {"error": "not_found"})
            return
        self._json(200, {"status": "ok", "model": self.predictor.metadata()})

    def do_POST(self) -> None:
        if self.path != "/v1/predict":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length < 1 or length > MAX_REQUEST_BYTES:
            self._json(413, {"error": "request_size", "message": "Request body must be from 1 byte to 1 MB."})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Request body must be a JSON object")
            self._json(200, self.predictor.predict(payload))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            self._json(400, {"error": "invalid_request", "message": str(error)})
        except Exception as error:
            print(f"Inference error: {error}")
            self._json(500, {"error": "inference_failed", "message": "Grounding inference failed."})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=os.environ.get("COACH_MODEL_PATH"), help="ONNX model or PyTorch checkpoint")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--ready-file", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.model:
        parser.error("--model or COACH_MODEL_PATH is required")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        parser.error("The grounding service must bind to a loopback address")
    predictor = create_predictor(args.model, args.device)
    handler = type("ConfiguredGroundingHandler", (GroundingRequestHandler,), {"predictor": predictor})
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(json.dumps({"status": "ready", "url": f"http://{args.host}:{args.port}", "model": predictor.metadata()}))
    try:
        if args.ready_file:
            args.ready_file.touch()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
