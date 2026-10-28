extends GutTest
## Skins that differ in extent. pixel-forge's own skins only recolour (alpha is kept), but the
## importer must not depend on that: one layout serves every skin, so each frame is cropped to the
## union of the skins' opaque pixels. These archives are built here from raw PNGs.

const S := preload("res://tests/support/pxf_support.gd")

var _made: Array[String] = []


func after_each() -> void:
	for path in _made:
		DirAccess.remove_absolute(path)
	_made.clear()


func _index(skins: Array) -> Dictionary:
	return {
		"schemaVersion": 1,
		"origin": {"x": 4, "y": 7},
		"pixelsPerUnit": 8,
		"directionFallback": {},
		"skins": skins,
		"animations": {
			"a": {
				"default": {
					"loop": "loop",
					"frames": [
						{
							"id": "frm_aaaaaa",
							"hash": "0",
							"durationMs": 100,
							"image": "a/default/0.png",
							"markers": {},
							"events": [],
							"rootMotion": {"dx": 0, "dy": 0},
						}
					],
				}
			}
		},
	}


func _png(size: Vector2i, pixels: Dictionary) -> PackedByteArray:
	var img := Image.create_empty(size.x, size.y, false, Image.FORMAT_RGBA8)
	for p: Vector2i in pixels:
		img.set_pixelv(p, pixels[p])
	return img.save_png_to_buffer()


func _archive(name: String, index: Dictionary, pngs: Dictionary) -> String:
	var path := "user://%s" % name
	var packer := ZIPPacker.new()
	assert_eq(packer.open(path), OK)
	packer.start_file("render/index.json")
	packer.write_file(JSON.stringify(index).to_utf8_buffer())
	packer.close_file()
	for entry: String in pngs:
		packer.start_file(entry)
		packer.write_file(pngs[entry])
		packer.close_file()
	packer.close()
	_made.append(path)
	return path


func _build(path: String, options: Dictionary, report: Dictionary = {}) -> PixelForgeAsset:
	var reader := S.Reader.new()
	assert_eq(reader.open(path), OK, reader.error_message)
	var asset := S.Asset.build(reader, options, report)
	reader.close()
	return asset


func test_trim_is_the_union_of_the_skins() -> void:
	var size := Vector2i(8, 8)
	var red := Color8(255, 0, 0, 255)
	var green := Color8(0, 255, 0, 255)
	var path := _archive("union.pxf", _index(["base", "alt"]), {
		"render/base/a/default/0.png": _png(size, {Vector2i(2, 2): red, Vector2i(3, 2): red}),
		"render/alt/a/default/0.png": _png(size, {Vector2i(2, 2): green, Vector2i(5, 6): green}),
	})
	var asset := _build(path, {"padding": 0})
	assert_not_null(asset)
	assert_eq(asset.frames[0]["offset_px"], Vector2i(2, 2))
	assert_eq(asset.frames[0]["region"].size, Vector2i(4, 5), "x 2..5 and y 2..6")
	for skin: StringName in [&"base", &"alt"]:
		var want := S.zip_png(path, skin, "a/default/0.png")
		assert_eq(S.canvas_frame(asset, skin, 0).get_data(), want.get_data(), "%s rebuilds exactly" % skin)
	# importing only the base skin crops tighter
	var base_only := _build(path, {"padding": 0, "skins": "base"})
	assert_eq(base_only.frames[0]["region"].size, Vector2i(2, 1))


func test_a_nearly_transparent_pixel_still_counts() -> void:
	var size := Vector2i(8, 8)
	var path := _archive("faint.pxf", _index(["base"]), {
		"render/base/a/default/0.png": _png(size, {Vector2i(6, 1): Color8(10, 20, 30, 1)}),
	})
	var asset := _build(path, {"padding": 0})
	assert_eq(asset.frames[0]["region"], Rect2i(0, 0, 1, 1), "packed at the origin of the atlas")
	assert_eq(asset.frames[0]["offset_px"], Vector2i(6, 1))
	assert_eq(S.canvas_frame(asset, &"base", 0).get_data(), S.zip_png(path, &"base", "a/default/0.png").get_data())


func test_a_fully_transparent_frame_is_one_pixel() -> void:
	var path := _archive("empty.pxf", _index(["base"]), {"render/base/a/default/0.png": _png(Vector2i(8, 8), {})})
	var asset := _build(path, {"padding": 0})
	assert_eq(asset.frames[0]["region"].size, Vector2i.ONE)
	assert_eq(asset.frames[0]["offset_px"], Vector2i.ZERO)
	assert_eq(S.canvas_frame(asset, &"base", 0).get_data(), S.zip_png(path, &"base", "a/default/0.png").get_data())


func test_a_skin_with_another_size_is_an_error() -> void:
	var red := Color8(255, 0, 0, 255)
	var path := _archive("sizes.pxf", _index(["base", "alt"]), {
		"render/base/a/default/0.png": _png(Vector2i(8, 8), {Vector2i(1, 1): red}),
		"render/alt/a/default/0.png": _png(Vector2i(9, 8), {Vector2i(1, 1): red}),
	})
	var report: Dictionary = {}
	assert_null(_build(path, {}, report))
	assert_string_contains(report["errors"][0], "render/alt/a/default/0.png")


func test_a_missing_png_is_an_error() -> void:
	var path := _archive("missing.pxf", _index(["base", "alt"]), {
		"render/base/a/default/0.png": _png(Vector2i(8, 8), {}),
	})
	var report: Dictionary = {}
	assert_null(_build(path, {}, report))
	assert_string_contains(report["errors"][0], "render/alt/a/default/0.png")
