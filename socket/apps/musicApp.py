from src import *

from os import remove, listdir
from os.path import abspath
from os.path import join as join_path
from genericpath import isfile

class MusicApp(App):
    def __init__(self, appdata_path: str):
        super().__init__(appdata_path)

        self.path = self.join_path("musicApp")
        self.abs_client_root = abspath(join_path(appdata_path, "..", "root")).replace('\\', '/')

        self.playlists = {}

    def write(self, update_type, **kwargs):
        if (update_type == "playlists_create"):
            if (not "name" in kwargs or kwargs["name"] in self.playlists):
                return (False)
            self.playlists[kwargs["name"]] = []
            return (True)

        if (update_type == "playlists_delete"):
            if (not "name" in kwargs or kwargs["name"] not in self.playlists):
                return (False)
            if (isfile(self.join_path("playlists", kwargs["name"] + ".lst"))):
                remove(self.join_path("playlists", kwargs["name"] + ".lst"))
            del self.playlists[kwargs["name"]]
            return (True)

        if (update_type == "song_add"):
            if (not "playlist" in kwargs or kwargs["playlist"] not in self.playlists):
                return (False)
            if (not "path" in kwargs or join_path(self.abs_client_root, kwargs["path"].replace('\\', '/').lstrip('/'))):
                return (False)
            self.playlists[kwargs["name"]].append({"endpoint": kwargs["path"].replace('\\', '/'), "cover": kwargs.get("cover", "default"), "name": kwargs.get("name", '.'.join(kwargs["path"].replace('\\', '/').split('/')[-1].split('.')[:-1]))})
            return (True)

        if (update_type == "song_delete"):
            if (not "playlist" in kwargs or kwargs["playlist"] not in self.playlists):
                return (False)
            if (not "id" in kwargs or kwargs["id"].isnumeric() or int(kwargs["id"]) >= len(self.playlists[kwargs["playlist"]])):
                return (False)
            del kwargs["playlist"][int(kwargs["id"])]
            return (True)

        return (False)

    def fetch(self, fetch_type, **kwargs):
        if (fetch_type == "playlists"):
            return {"type": fetch_type, "content": [{"name": item, "songs": self.playlists[item]} for item in self.playlists]}

        return (None)

    def save(self):
        for item in self.playlists:
            with open(self.join_path("playlists", item + '.lst'), 'w') as fp:
                for song in sorted(self.playlists[item], key=lambda x: x["id"]):
                    fp.write(f"{song['endpoint']} {song['cover']} {song['name']}\n")

        return super().save()

    def load(self):
        self.playlists.clear()

        for item in listdir(self.join_path("playlists")):
            song_id = 0

            self.playlists['.'.join(item.split('.')[:-1])] = []

            with open(self.join_path("playlists", item), 'r') as fp:
                for line in fp.readlines():
                    line = line.strip()

                    if (not line):
                        continue

                    music, cover, *name = tuple(filter(lambda x: x != "", line.replace('\t', '').split(' ')))

                    self.playlists[item.split('.')[0]].append({"id": song_id, "endpoint": music, "name": ' '.join(name), "cover": cover})

                    song_id += 1

        return super().load()
