from psycopg2 import connect

class DataBase(object):
    def __init__(self, host, db, user, password):
        self._db = connect(dbname=db, user=user, host=host, password=password)
        self._cursor = self._db.cursor()

    def fetch_dao(self, table, instance, extension="", variables=[]):
        values = []

        self._cursor.execute(f"SELECT {', '.join(instance.SCHEMA)} FROM {table}{'' if not extension else ' ' + extension};", variables)
        for item in self._cursor.fetchall():
            values.append(instance(*item))

        return (values)

    def write_dao(self, table, obj, instance):
        obj_obj = obj.to_object()
        values = []

        self._cursor.execute(f"INSERT INTO {table} ({', '.join(filter(lambda x: instance.SCHEMA[x] != 'id', instance.SCHEMA))}) VALUES ({', '.join(map(lambda _: r"%s", filter(lambda x: instance.SCHEMA[x] != 'id', instance.SCHEMA)))}) RETURNING {', '.join(instance.SCHEMA)};", list(map(lambda x: obj_obj[x], filter(lambda x: instance.SCHEMA[x] != 'id', instance.SCHEMA))))
        values.append(instance(*self._cursor.fetchone()))
        self._db.commit()

        return (values)

    def close(self):
        if (not self._cursor.closed):
            self._cursor.close()
        if (not self._db.closed):
            self._db.commit()
            self._db.close()