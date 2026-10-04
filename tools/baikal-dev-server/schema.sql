-- SQLite schema of sabre/dav 4 (users, principals, calendars, property storage, locks).
-- Copied from sabre/dav's examples/sql, which Composer dist archives don't include.

-- sqlite.users.sql
CREATE TABLE users (
	id integer primary key asc NOT NULL,
	username TEXT NOT NULL,
	digesta1 TEXT NOT NULL,
	UNIQUE(username)
);

INSERT INTO users (username,digesta1) VALUES
('admin',  '87fd274b7b6c01e48d7c2f965da8ddf7');

-- sqlite.principals.sql
CREATE TABLE principals (
    id INTEGER PRIMARY KEY ASC NOT NULL,
    uri TEXT NOT NULL,
    email TEXT,
    displayname TEXT,
    UNIQUE(uri)
);

CREATE TABLE groupmembers (
    id INTEGER PRIMARY KEY ASC NOT NULL,
    principal_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    UNIQUE(principal_id, member_id)
);


INSERT INTO principals (uri,email,displayname) VALUES ('principals/admin', 'admin@example.org','Administrator');
INSERT INTO principals (uri,email,displayname) VALUES ('principals/admin/calendar-proxy-read', null, null);
INSERT INTO principals (uri,email,displayname) VALUES ('principals/admin/calendar-proxy-write', null, null);


-- sqlite.calendars.sql
CREATE TABLE calendarobjects (
    id integer primary key asc NOT NULL,
    calendardata blob NOT NULL,
    uri text NOT NULL,
    calendarid integer NOT NULL,
    lastmodified integer NOT NULL,
    etag text NOT NULL,
    size integer NOT NULL,
    componenttype text,
    firstoccurence integer,
    lastoccurence integer,
    uid text,
    UNIQUE(calendarid,uri)
);
CREATE INDEX calendarid_time ON calendarobjects (calendarid, firstoccurence);

CREATE TABLE calendars (
    id integer primary key asc NOT NULL,
    synctoken integer DEFAULT 1 NOT NULL,
    components text NOT NULL
);

CREATE TABLE calendarinstances (
    id integer primary key asc NOT NULL,
    calendarid integer NOT NULL,
    principaluri text NULL,
    access integer COMMENT '1 = owner, 2 = read, 3 = readwrite' NOT NULL DEFAULT '1',
    displayname text,
    uri text NOT NULL,
    description text,
    calendarorder integer,
    calendarcolor text,
    timezone text,
    transparent bool,
    share_href text,
    share_displayname text,
    share_invitestatus integer DEFAULT '2',
    UNIQUE (principaluri, uri),
    UNIQUE (calendarid, principaluri),
    UNIQUE (calendarid, share_href)
);

CREATE TABLE calendarchanges (
    id integer primary key asc NOT NULL,
    uri text,
    synctoken integer NOT NULL,
    calendarid integer NOT NULL,
    operation integer NOT NULL
);

CREATE INDEX calendarid_synctoken ON calendarchanges (calendarid, synctoken);

CREATE TABLE calendarsubscriptions (
    id integer primary key asc NOT NULL,
    uri text NOT NULL,
    principaluri text NOT NULL,
    source text NOT NULL,
    displayname text,
    refreshrate text,
    calendarorder integer,
    calendarcolor text,
    striptodos bool,
    stripalarms bool,
    stripattachments bool,
    lastmodified int,
    UNIQUE(principaluri, uri)
);

CREATE TABLE schedulingobjects (
    id integer primary key asc NOT NULL,
    principaluri text NOT NULL,
    calendardata blob,
    uri text NOT NULL,
    lastmodified integer,
    etag text NOT NULL,
    size integer NOT NULL,
    UNIQUE(principaluri, uri)
);

-- sqlite.propertystorage.sql
CREATE TABLE propertystorage (
    id integer primary key asc NOT NULL,
    path text NOT NULL,
    name text NOT NULL,
    valuetype integer NOT NULL,
    value string
);

CREATE UNIQUE INDEX path_property ON propertystorage (path, name);

-- sqlite.locks.sql
CREATE TABLE 'locks' (
    id integer primary key asc NOT NULL,
    owner text,
    timeout integer,
    created integer,
    token text,
    scope integer,
    depth integer,
    uri text
);
CREATE INDEX idx_uri ON 'locks' (uri);

