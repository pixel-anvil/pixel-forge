extends GutTest
## PixelForgePxfReader: ZIPReader + JSON + Image.load_png_from_buffer, render cache only.

const S := preload("res://tests/support/pxf_support.gd")

var _made: Array[String] = []


func after_each() -> void:
	for path in _made:
		DirAccess.remove_absolute(path)
	_made.clear()


## Writes a ZIP to user:// with the given entries (name -> bytes) and returns its path.
func _zip(name: String, entries: Dictionary) -> String:
	var path := "user://%s" % name
	var packer := ZIPPacker.new()
	assert_eq(packer.open(path), OK)
	for entry: String in entries:
		packer.start_file(entry)
		packer.write_file(entries[entry])
		packer.close_file()
	packer.close()
	_made.append(path)
	return path


func _good_index() -> Dictionary:
	return S.zip_index(S.WALKER)


func _index_zip(name: String, index: Variant) -> String:
	return _zip(name, {"render/index.json": JSON.stringify(index).to_utf8_buffer()})


func test_open_reads_the_index() -> void:
	var r := S.Reader.new()
	assert_eq(r.open(S.WALKER), OK, r.error_message)
	assert_true(r.is_open())
	assert_eq(r.index["origin"], {"x": 12.0, "y": 23.0})
	assert_eq(r.index["pixelsPerUnit"], 16.0)
	assert_eq(r.index["skins"], ["base"])
	assert_true(r.index["animations"].has("walk"))
	assert_true(r.has_file("render/base/walk/side/0.png"))
	assert_false(r.has_file("render/base/walk/side/9.png"))


func test_read_png_matches_a_plain_decode() -> void:
	var r := S.Reader.new()
	assert_eq(r.open(S.WALKER), OK)
	var img := r.read_png("base", "walk/side/1.png")
	assert_not_null(img)
	assert_eq(img.get_format(), Image.FORMAT_RGBA8)
	assert_eq(img.get_size(), Vector2i(24, 24))
	assert_eq(img.get_data(), S.zip_png(S.WALKER, "base", "walk/side/1.png").get_data())


func test_read_png_reads_other_skins() -> void:
	var r := S.Reader.new()
	assert_eq(r.open(S.SKINS), OK)
	var base := r.read_png("base", "blink/default/0.png")
	var ghost := r.read_png("ghost", "blink/default/0.png")
	assert_ne(base.get_data(), ghost.get_data())


func test_read_png_errors() -> void:
	var r := S.Reader.new()
	assert_eq(r.open(S.WALKER), OK)
	assert_null(r.read_png("base", "walk/side/9.png"))
	assert_string_contains(r.error_message, "render/base/walk/side/9.png")
	assert_null(r.read_png("nope", "walk/side/0.png"))
	var closed := S.Reader.new()
	assert_null(closed.read_png("base", "walk/side/0.png"))
	assert_string_contains(closed.error_message, "not open")


func test_close_forgets_everything() -> void:
	var r := S.Reader.new()
	assert_eq(r.open(S.WALKER), OK)
	r.close()
	assert_false(r.is_open())
	assert_true(r.index.is_empty())
	assert_false(r.has_file("render/index.json"))


func test_open_a_missing_file() -> void:
	var r := S.Reader.new()
	assert_ne(r.open("res://fixtures/missing.pxf"), OK)
	assert_string_contains(r.error_message, "missing.pxf")
	assert_false(r.is_open())


func test_open_a_file_that_is_not_a_zip() -> void:
	var r := S.Reader.new()
	assert_ne(r.open("res://project.godot"), OK)
	assert_false(r.is_open())


func test_open_without_a_render_cache() -> void:
	var path := _zip("no_cache.pxf", {"manifest.json": "{}".to_utf8_buffer()})
	var r := S.Reader.new()
	assert_eq(r.open(path), ERR_FILE_CORRUPT)
	assert_string_contains(r.error_message, "render cache")


func test_open_with_broken_json() -> void:
	var path := _zip("bad_json.pxf", {"render/index.json": "{not json".to_utf8_buffer()})
	var r := S.Reader.new()
	assert_eq(r.open(path), ERR_PARSE_ERROR)
	assert_string_contains(r.error_message, "render/index.json")


func test_open_rejects_a_newer_schema_version() -> void:
	var index := _good_index()
	index["schemaVersion"] = 2
	var r := S.Reader.new()
	assert_eq(r.open(_index_zip("v2.pxf", index)), ERR_INVALID_DATA)
	assert_string_contains(r.error_message, "newer")


func test_open_rejects_a_malformed_index() -> void:
	var cases := {
		"no skins": func(i: Dictionary) -> void: i.erase("skins"),
		"no base skin": func(i: Dictionary) -> void: i["skins"] = ["other"],
		"bad origin": func(i: Dictionary) -> void: i["origin"] = {"x": 1},
		"zero ppu": func(i: Dictionary) -> void: i["pixelsPerUnit"] = 0,
		"no frames": func(i: Dictionary) -> void: i["animations"]["walk"]["side"]["frames"] = [],
		"bad loop": func(i: Dictionary) -> void: i["animations"]["walk"]["side"]["loop"] = "spin",
		"no image": func(i: Dictionary) -> void: i["animations"]["walk"]["side"]["frames"][0].erase("image"),
		"bad duration": func(i: Dictionary) -> void: i["animations"]["walk"]["side"]["frames"][0]["durationMs"] = 0,
		"bad marker": func(i: Dictionary) -> void: i["animations"]["walk"]["side"]["frames"][0]["markers"]["ball"] = {"x": 1},
		"mirror of nothing": func(i: Dictionary) -> void: i["animations"]["walk"]["left"]["mirrorOf"] = "nope",
	}
	for label: String in cases:
		var index := _good_index()
		(cases[label] as Callable).call(index)
		var r := S.Reader.new()
		assert_eq(r.open(_index_zip("case.pxf", index)), ERR_INVALID_DATA, label)
		assert_ne(r.error_message, "", label)


func test_only_the_render_cache_is_needed() -> void:
	# FR-GD-05: an archive holding nothing but render/ (no manifest, no document.json, no images/)
	# imports completely.
	var entries := {"render/index.json": S.zip_bytes(S.WALKER, "render/index.json")}
	var zip := ZIPReader.new()
	assert_eq(zip.open(S.WALKER), OK)
	for entry in zip.get_files():
		if entry.begins_with("render/"):
			entries[entry] = zip.read_file(entry)
	zip.close()
	var path := _zip("render_only.pxf", entries)
	var reader := S.Reader.new()
	assert_eq(reader.open(path), OK, reader.error_message)
	var report: Dictionary = {}
	var asset := S.Asset.build(reader, {}, report)
	assert_not_null(asset, str(report))
	assert_eq(asset.frames.size(), 9)
