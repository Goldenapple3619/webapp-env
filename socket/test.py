from websockets.sync.client import connect
from json import dumps

from sys import exit


def main() -> int:
    with connect("ws://localhost:2117") as websocket:
        websocket.send(dumps({"action": "connect", "data": {"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6Inh5eiIsImRhdGUiOiIyMDI1LTA1LTI4VDA5OjU4OjE1LjM2MloiLCJpYXQiOjE3NDg0MjYyOTV9.uuPgcB_GkeMlT-UIhFou2m0JWmx_sY4ISwDdUt_4N8Y"}}))
        while 1:
            message = websocket.recv()

            print(message)

    return (0)


if __name__ == "__main__":
    exit(main())