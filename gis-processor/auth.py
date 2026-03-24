"""API key authentication decorator for Flask routes."""
import functools
from flask import request, jsonify, current_app


def require_api_key(f):
    @functools.wraps(f)
    def decorated(*args, **kwargs):
        api_key = current_app.config.get('API_KEY')
        if not api_key:
            # No key configured — allow all (dev mode)
            return f(*args, **kwargs)

        # Check Authorization header: "Bearer <key>"
        auth_header = request.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:].strip()
            if token == api_key:
                return f(*args, **kwargs)

        # Check X-API-Key header
        if request.headers.get('X-API-Key') == api_key:
            return f(*args, **kwargs)

        return jsonify({'error': 'Unauthorized'}), 401

    return decorated
