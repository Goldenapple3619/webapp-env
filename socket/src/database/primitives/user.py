from datetime import datetime

class User(object):
    SCHEMA = {
        "username": 'string',
        "token": 'string',
        "password": 'string',
        "id": 'id',
        "creation_date": 'string'
    }

    def __init__(self, username, token = None, password = "", userid = None, creation_date = datetime.now()):
        self.username = username
        self.token = token
        self.password = password
        self.id = userid
        self.creation_date = creation_date

    def to_object(self):
        return ({
            "username": self.username,
            "token": self.token,
            "password": self.password,
            "id": self.id,
            "creation_date": self.creation_date
        })
