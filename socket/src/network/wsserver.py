from websockets.sync.server import WebSocketServer, ServerConnection

from genericpath import isdir
from os import mkdir
from json import dumps, loads
from signal import signal, SIGINT, SIGTERM
from traceback import format_exc

class MessageJSON(object):
    def __init__(self, action = "uknown", data = {}, code = 0):
        self.action = action
        self.data = data
        self.code = code

    @staticmethod
    def from_raw(data):
        message: MessageJSON = MessageJSON
        data: dict = loads(data)

        message.action = data.get("action", "uknown")
        message.data = data.get("data", {})
        message.code = data.get("code", 0)

        return (message)

    def to_raw(self):
        return (dumps({"action": self.action, "data": self.data, "code": self.code}))

class App(object):
    def __init__(self, appdata_path: str):
        self.path = appdata_path

        self.closed = False

    def load(self):
        pass

    def fetch(self, *args, **kwargs):
        pass

    def write(self, *args, **kwargs):
        pass

    def join_path(self, *path) -> str:
        path = '/'.join(map(lambda x: x.strip('/').strip('\\'), path))
        return (self.path.rstrip('/').rstrip('\\') + "/" + str(path)).replace('\\', '/')

    def save(self):
        if (self.closed):
            return

        if (not isdir(self.path)):
            mkdir(self.path)

    def close(self):
        self.closed = True

    def __del__(self):
        self.close()

class AppSession(object):
    def __init__(self, session_id: str, app_class: App):
        self.session_id: str = session_id
        self.app: str = app_class

        self.app.load()

    def read(self, *args, **kwargs):
        if (self.app.closed):
            return
        return (self.app.fetch(*args, **kwargs))

    def write(self, *args, **kwargs):
        if (self.app.closed):
            return
        return self.app.write(*args, **kwargs)

    def save(self):
        self.app.save()

    def close(self):
        self.session_id = None

        if (self.app.closed):
            return

        self.save()

        self.app.close()

    def __del__(self):
        self.close()

class Client(object):
    def __init__(self, socket, *, login = False, user_id = -1):
        self.socket = socket
        self.login = login
        self.id = user_id
        self.started_apps_sessions = []

    def get_app(self, session_id) -> AppSession:
        for item in self.started_apps_sessions:
            if (item.session_id == session_id):
                return item
        return (None)

    def close_app(self, session_id):
        for i, item in tuple(enumerate(self.started_apps_sessions)):
            if (item.session_id == session_id):
                self.started_apps_sessions.pop(i)
                return

    def send_message(self, message: MessageJSON):
        self.socket.send(message.to_raw())

    def read_message(self):
        return (MessageJSON.from_raw(self.socket.recv()))

    def close(self):
        for item in self.started_apps_sessions:
            item.close()
        self.started_apps_sessions.clear()
        self.socket.close()

    def __del__(self):
        self.close()

class Server(object):
    def __init__(self, websocket_builder, *, close_message = None):
        self.websocket: WebSocketServer = websocket_builder(self._serve)

        self._routes = {}
        self.clients = {}

        self.close_message: MessageJSON = close_message

        signal(SIGINT, lambda *args: self.close())
        signal(SIGTERM, lambda *args: self.close())

    def _serve(self, websocket: ServerConnection):
        self.clients[websocket] = Client(websocket, login=False)

        try:
            for message in websocket:
                message = MessageJSON.from_raw(message)

                route = self._routes.get(message.action, None)

                if (not route):
                    websocket.send(MessageJSON("invalid_action", code=1).to_raw())

                route(self, self.clients[websocket], message)
        except Exception as e:
            print(format_exc())

        if (websocket in self.clients):
            del self.clients[websocket]

    def add_route(self, name, callback):
        self._routes[name] = callback

    def serve(self):
        self.websocket.serve_forever()

    def __del__(self):
        self.close()

    def close(self):
        for item in tuple(self.clients.values()):
            if (self.close_message):
                item.send_message(self.close_message)

            item.close()

        self.clients.clear()
        self.websocket.shutdown()
