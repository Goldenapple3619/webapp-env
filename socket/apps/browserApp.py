from src import App, AppError, FsError, UserFS

class Uri:
    def __init__(self, protocol = "local", user = "", host = "", port = "", path = None, query = None, fragment = ""):
        self.protocol = protocol
        self.authority = {
            "user": user,
            "host": host,
            "port": port
        }
        self.path = path if path else list()
        self.query = query if query else list()
        self.fragment = fragment

        if (not path):
            self.path.append("/")

    @staticmethod
    def from_string(string: str):
        protocol = string.split("://")[0]

        after_protocol = '://'.join(string.split("://")[1:]) if "://" in string else ""
        authority = after_protocol.split("#")[0].split("?")[0].split('/')[0]

        userinfo = authority.split("@")[0] if "@" in authority else ""
        port = authority.split(":")[1] if ":" in authority else ""
        host = authority.split("@")[1].split(':')[0] if "@" in authority else authority.split(':')[0]

        path = after_protocol.split("#")[0].split("?")[0].split('/')[1:] if "/" in after_protocol else ""

        url_hash = '#'.join(after_protocol.split("#")[1:]) if "#" in after_protocol else ""
        url_query = '?'.join(after_protocol.split("?")[1:]).split("#")[0].split("&") if "?" in after_protocol else ""

        return (Uri(protocol, userinfo, port, host, path, url_query, url_hash))

class BrowserApp(App):
    topics = ()

    def __init__(self, ctx):
        super().__init__(ctx)
        self.fs = UserFS(ctx.root_path)

    @staticmethod
    def _get_file_type_from_ext(ext: str):
        if (ext == "html"):
            return ("html")
        return ("txt")

    def fetch(self, fetch_type, **kwargs):
        if fetch_type == "uri":
            if (not kwargs.get("uri")):
                raise AppError("missing_uri")

            url = Uri.from_string(kwargs.get("uri"))

            if (url.protocol == "local"):
                try:
                    stat = self.fs.stat('/'.join(url.path))
                except FsError:
                    return ({"type": "uri", "status": "not_found", "content_type": "nul", "body": ""})

                if (stat.get("type", "file") != "file"):
                    return ({"type": "uri", "status": "not_found", "content_type": "nul", "body": ""})
                return ({"type": "uri", "status": "ok", "content_type": self._get_file_type_from_ext(url.path[-1].split('.')[-1]), "body": self.fs.read_text('/'.join(url.path))})

    def write(self, update_type, **kwargs):
        pass
