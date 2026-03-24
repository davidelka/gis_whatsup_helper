"""
Service manager for starting/stopping WhatsApp and Telegram listener processes.
"""
import os
import signal
import subprocess
import time
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SERVICES = {
    'whatsapp': {
        'name': 'WhatsApp Listener',
        'cwd': 'whatsapp-listener',
        'command': ['npm', 'run', 'dev'],
    },
    'telegram': {
        'name': 'Telegram Listener',
        'cwd': 'telegram-listener',
        'command': ['npm', 'run', 'dev'],
    },
}


class ServiceManager:
    def __init__(self, project_root: str):
        self.project_root = project_root
        self.processes: dict[str, subprocess.Popen] = {}
        self.start_times: dict[str, float] = {}
        self.log_dir = os.path.join(project_root, 'gis-processor', 'data', 'logs')
        os.makedirs(self.log_dir, exist_ok=True)

    def start(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        if self.is_running(service_name):
            return {'error': f'{service_name} is already running', 'status': 'running'}

        svc = SERVICES[service_name]
        cwd = os.path.join(self.project_root, svc['cwd'])

        if not os.path.isdir(cwd):
            return {'error': f'Service directory not found: {cwd}'}

        log_path = os.path.join(self.log_dir, f'{service_name}.log')
        log_file = open(log_path, 'a')

        try:
            proc = subprocess.Popen(
                svc['command'],
                cwd=cwd,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                preexec_fn=os.setsid,
            )
            self.processes[service_name] = proc
            self.start_times[service_name] = time.time()

            logger.info(f'Started {svc["name"]} (PID {proc.pid})')
            return {
                'status': 'started',
                'pid': proc.pid,
                'name': svc['name'],
            }
        except Exception as e:
            log_file.close()
            logger.error(f'Failed to start {service_name}: {e}')
            return {'error': str(e)}

    def stop(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        proc = self.processes.get(service_name)
        if not proc or proc.poll() is not None:
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)
            return {'status': 'stopped', 'name': SERVICES[service_name]['name']}

        try:
            # Send SIGTERM to the process group
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                proc.wait(timeout=5)

            logger.info(f'Stopped {SERVICES[service_name]["name"]} (PID {proc.pid})')
        except Exception as e:
            logger.error(f'Error stopping {service_name}: {e}')
        finally:
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)

        return {'status': 'stopped', 'name': SERVICES[service_name]['name']}

    def status(self, service_name: str) -> dict:
        if service_name not in SERVICES:
            return {'error': f'Unknown service: {service_name}'}

        svc = SERVICES[service_name]
        proc = self.processes.get(service_name)
        running = proc is not None and proc.poll() is None

        if not running and proc is not None:
            # Process exited, clean up
            self.processes.pop(service_name, None)
            self.start_times.pop(service_name, None)

        result = {
            'name': svc['name'],
            'service': service_name,
            'running': running,
        }

        if running and proc:
            result['pid'] = proc.pid
            start_time = self.start_times.get(service_name, 0)
            result['uptime_seconds'] = int(time.time() - start_time) if start_time else 0

        return result

    def status_all(self) -> list:
        return [self.status(name) for name in SERVICES]

    def is_running(self, service_name: str) -> bool:
        proc = self.processes.get(service_name)
        return proc is not None and proc.poll() is None

    def get_logs(self, service_name: str, lines: int = 100) -> str:
        log_path = os.path.join(self.log_dir, f'{service_name}.log')
        if not os.path.exists(log_path):
            return ''

        try:
            with open(log_path, 'r') as f:
                all_lines = f.readlines()
                return ''.join(all_lines[-lines:])
        except Exception:
            return ''

    def stop_all(self):
        for name in list(self.processes.keys()):
            self.stop(name)
