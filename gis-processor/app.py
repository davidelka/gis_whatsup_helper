"""
Flask application factory for the GIS processor service.

Registers blueprints, initialises shared resources (database engine,
service manager, directories), and exposes the small number of routes
that belong at the application level (/health, /media/<filename>).
"""
import atexit
import os
import sys

import yaml
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

# Ensure the gis-processor package root is on sys.path when the file is
# executed directly (python app.py) as well as when imported.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from models import init_db
from service_manager import ServiceManager
from routes.data import data_bp
from routes.export import export_bp
from routes.management import management_bp, migrate_config_groups
from routes.dashboard import dashboard_bp


# ---------------------------------------------------------------------------
# Configuration loader
# ---------------------------------------------------------------------------

def load_config() -> dict:
    config_path = os.path.join(os.path.dirname(__file__), '..', 'config.yaml')
    if os.path.exists(config_path):
        with open(config_path, 'r') as f:
            return yaml.safe_load(f)
    return {
        'storage': {
            'database': 'sqlite:///data/messages.db',
            'export_dir': './exports'
        },
        'python_service': {
            'host': 'localhost',
            'port': 5000
        }
    }


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

def create_app() -> Flask:
    app = Flask(__name__)
    CORS(app, origins=['http://localhost:5000', 'http://127.0.0.1:5000'])

    # --- Config ---
    config = load_config()
    database_url = config['storage']['database']
    export_dir = config['storage']['export_dir']
    media_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'media')
    os.makedirs(media_dir, exist_ok=True)

    # --- Database ---
    engine = init_db(database_url)

    # --- Service manager ---
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    service_manager = ServiceManager(project_root)

    # --- Shared state on app.config so blueprints can reach it via current_app ---
    app.config['ENGINE'] = engine
    app.config['CONFIG'] = config
    app.config['MEDIA_DIR'] = media_dir
    app.config['EXPORT_DIR'] = export_dir
    app.config['SERVICE_MANAGER'] = service_manager

    # --- Register blueprints ---
    app.register_blueprint(data_bp)
    app.register_blueprint(export_bp)
    app.register_blueprint(management_bp)
    app.register_blueprint(dashboard_bp)

    # --- Core routes (stay at app level) ---

    @app.route('/health', methods=['GET'])
    def health_check():
        """Health check endpoint."""
        return jsonify({'status': 'healthy', 'service': 'gis-processor'})

    @app.route('/media/<path:filename>')
    def serve_media(filename):
        """Serve media files from the media directory."""
        return send_from_directory(media_dir, filename)

    # --- Cleanup on exit ---
    atexit.register(service_manager.stop_all)

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

app = create_app()

if __name__ == '__main__':
    config = app.config['CONFIG']
    export_dir = app.config['EXPORT_DIR']
    host = config['python_service']['host']
    port = config['python_service']['port']

    # Migrate config.yaml groups to database on first run
    with app.app_context():
        migrate_config_groups()

    # Ensure export directory exists
    os.makedirs(export_dir, exist_ok=True)

    print(f"Starting GIS Processor on http://{host}:{port}")
    print(f"Dashboard: http://{host}:{port}/dashboard")
    print(f"Management: http://{host}:{port}/management")
    print(f"Database: {config['storage']['database']}")

    app.run(host=host, port=port, debug=False)
