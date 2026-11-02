@tool
class_name PixelForgePxfReader
extends RefCounted
## Reads the render cache of a pixel-forge `.pxf` file (FR-GD-05).
##
## A `.pxf` is a ZIP archive. This reader only touches `render/index.json` and the frame PNGs under
## `render/<skin>/`; it never reads `document.json`, so the rig is never evaluated in Godot.
## Format reference: docs/01-spec.md section 7 and packages/schema/src/render.ts.
##
## Usage:
##   var reader := PixelForgePxfReader.new()
##   if reader.open("res://hero.pxf") != OK:
##       push_error(reader.error_message)
##   var image: Image = reader.read_png("base", "walk/side/0.png")

## Highest `render/index.json` `schemaVersion` this reader understands.
const SUPPORTED_SCHEMA_VERSION := 1
const INDEX_PATH := "render/index.json"
const BASE_SKIN := "base"
const LOOP_MODES: PackedStringArray = ["loop", "once", "pingpong"]

## The parsed `render/index.json` (JSON numbers are floats, as Godot parses them). Empty until
## `open()` succeeds.
var index: Dictionary = {}
## Why the last call that returned an error failed.
var error_message: String = ""

var _zip: ZIPReader = null
var _entries: Dictionary = {}


## Opens `path` (a `res://`, `user://` or filesystem path) and loads and validates the render index.
func open(path: String) -> Error:
	close()
	var zip := ZIPReader.new()
	var err := zip.open(path)
	if err != OK:
		return _fail(err, "cannot open '%s' as a ZIP archive (%s)" % [path, error_string(err)])
	_zip = zip
	for entry in zip.get_files():
		_entries[entry] = true
	if not _entries.has(INDEX_PATH):
		close()
		return _fail(ERR_FILE_CORRUPT, "'%s' has no %s (saved without a render cache?)" % [path, INDEX_PATH])
	var json := JSON.new()
	var text := _zip.read_file(INDEX_PATH).get_string_from_utf8()
	if json.parse(text) != OK:
		close()
		return _fail(
			ERR_PARSE_ERROR,
			"%s line %d: %s" % [INDEX_PATH, json.get_error_line(), json.get_error_message()]
		)
	var problem := _validate_index(json.data)
	if problem != "":
		close()
		return _fail(ERR_INVALID_DATA, "%s: %s" % [INDEX_PATH, problem])
	index = json.data
	error_message = ""
	return OK


## Closes the archive and forgets the index.
func close() -> void:
	if _zip != null:
		_zip.close()
	_zip = null
	_entries = {}
	index = {}


func is_open() -> bool:
	return _zip != null


## Whether the archive has an entry called `entry_path`.
func has_file(entry_path: String) -> bool:
	return _entries.has(entry_path)


## Decodes `render/<skin>/<image>` to an RGBA8 `Image`. Returns null (and sets `error_message`) when
## the entry is missing or is not a PNG.
func read_png(skin: String, image: String) -> Image:
	if _zip == null:
		_fail(ERR_UNCONFIGURED, "the reader is not open")
		return null
	var entry := "render/%s/%s" % [skin, image]
	if not _entries.has(entry):
		_fail(ERR_FILE_NOT_FOUND, "missing %s" % entry)
		return null
	var img := Image.new()
	var err := img.load_png_from_buffer(_zip.read_file(entry))
	if err != OK:
		_fail(err, "%s is not a readable PNG (%s)" % [entry, error_string(err)])
		return null
	if img.get_format() != Image.FORMAT_RGBA8:
		img.convert(Image.FORMAT_RGBA8)
	return img


func _fail(err: Error, message: String) -> Error:
	error_message = message
	return err


## Returns "" when the index has the shape this reader relies on, else a description of the first
## problem found.
func _validate_index(data: Variant) -> String:
	if typeof(data) != TYPE_DICTIONARY:
		return "expected an object"
	var d: Dictionary = data
	var version: Variant = d.get("schemaVersion")
	if not _is_number(version) or int(version) < 1:
		return "schemaVersion is missing or invalid"
	if int(version) > SUPPORTED_SCHEMA_VERSION:
		return "schemaVersion %d is newer than this addon supports (%d)" % [
			int(version), SUPPORTED_SCHEMA_VERSION
		]
	if not _is_point(d.get("origin")):
		return "origin must be {x, y}"
	var ppu: Variant = d.get("pixelsPerUnit")
	if not _is_number(ppu) or float(ppu) <= 0.0:
		return "pixelsPerUnit must be a positive number"
	if typeof(d.get("directionFallback")) != TYPE_DICTIONARY:
		return "directionFallback must be an object"
	var skins: Variant = d.get("skins")
	if typeof(skins) != TYPE_ARRAY or not (skins as Array).has(BASE_SKIN):
		return "skins must be a list that includes \"%s\"" % BASE_SKIN
	if typeof(d.get("animations")) != TYPE_DICTIONARY:
		return "animations must be an object"
	var animations: Dictionary = d["animations"]
	for group: Variant in animations:
		var dirs: Variant = animations[group]
		if typeof(dirs) != TYPE_DICTIONARY:
			return "animations.%s must be an object" % group
		for direction: Variant in dirs:
			var problem := _validate_entry(animations, str(group), str(direction), dirs[direction])
			if problem != "":
				return problem
	return ""


func _validate_entry(animations: Dictionary, group: String, direction: String, entry: Variant) -> String:
	var where := "animations.%s.%s" % [group, direction]
	if typeof(entry) != TYPE_DICTIONARY:
		return "%s must be an object" % where
	var e: Dictionary = entry
	if not (e.get("loop") in LOOP_MODES):
		return "%s.loop must be one of %s" % [where, ", ".join(LOOP_MODES)]
	if e.has("mirrorOf"):
		var source: Variant = (animations[group] as Dictionary).get(e["mirrorOf"])
		if typeof(source) != TYPE_DICTIONARY or not (source as Dictionary).has("frames"):
			return "%s.mirrorOf must name an authored direction of the same group" % where
		return ""
	if typeof(e.get("frames")) != TYPE_ARRAY or (e["frames"] as Array).is_empty():
		return "%s.frames must be a non-empty list" % where
	var i := 0
	for frame: Variant in e["frames"]:
		if typeof(frame) != TYPE_DICTIONARY:
			return "%s.frames[%d] must be an object" % [where, i]
		var f: Dictionary = frame
		if typeof(f.get("image")) != TYPE_STRING:
			return "%s.frames[%d].image must be a string" % [where, i]
		if not _is_number(f.get("durationMs")) or int(f["durationMs"]) < 1:
			return "%s.frames[%d].durationMs must be a positive integer" % [where, i]
		if typeof(f.get("markers")) != TYPE_DICTIONARY:
			return "%s.frames[%d].markers must be an object" % [where, i]
		for marker: Variant in f["markers"]:
			if not _is_point(f["markers"][marker]):
				return "%s.frames[%d].markers.%s must be {x, y}" % [where, i, marker]
		if typeof(f.get("events")) != TYPE_ARRAY:
			return "%s.frames[%d].events must be a list" % [where, i]
		var motion: Variant = f.get("rootMotion")
		if (
			typeof(motion) != TYPE_DICTIONARY
			or not _is_number((motion as Dictionary).get("dx"))
			or not _is_number((motion as Dictionary).get("dy"))
		):
			return "%s.frames[%d].rootMotion must be {dx, dy}" % [where, i]
		i += 1
	return ""


static func _is_number(v: Variant) -> bool:
	return typeof(v) == TYPE_FLOAT or typeof(v) == TYPE_INT


static func _is_point(v: Variant) -> bool:
	return (
		typeof(v) == TYPE_DICTIONARY
		and _is_number((v as Dictionary).get("x"))
		and _is_number((v as Dictionary).get("y"))
	)
