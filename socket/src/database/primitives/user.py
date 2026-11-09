from datetime import datetime


class User(object):
    SCHEMA = {
        "id": "id",
        "username": "string",
        "creation_date": "string",
    }

    def __init__(self, userid=None, username="", creation_date=None):
        self.id = userid
        self.username = username
        self.creation_date = creation_date or datetime.now()

    def to_object(self):
        return {"id": self.id, "username": self.username, "creation_date": self.creation_date}
