from hashlib import md5

def hash_file(path: str, algorithm: object = md5, chunk_size: int = 8192) -> str:
    hash_builder = algorithm()

    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(chunk_size), b""):
            hash_builder.update(chunk)

    return hash_builder.hexdigest()
