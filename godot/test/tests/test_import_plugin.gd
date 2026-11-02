extends GutTest
## The import plugin (FR-GD-01). EditorImportPlugin only exists inside the editor, so a plain
## headless run tests the import step (`PixelForgeImport`) directly, and checks the plugin itself
## through what `godot --import` produced for res://fixtures/*.pxf (run_tests.sh imports first).

const S := preload("res://tests/support/pxf_support.gd")
const Import := preload("res://addons/pixel_forge/pixel_forge_import.gd")

var _made: Array[String] = []


func after_each() -> void:
	for path in _made:
		DirAccess.remove_absolute(path)
	_made.clear()


func test_the_plugin_registered_the_importer() -> void:
	var cfg := ConfigFile.new()
	assert_eq(cfg.load(S.WALKER + ".import"), OK, "godot --import wrote a .import file")
	assert_eq(cfg.get_value("remap", "importer"), "pixel_forge.pxf")
	assert_eq(cfg.get_value("remap", "type"), "Resource")
	assert_true(String(cfg.get_value("remap", "path")).ends_with(".res"))
	assert_eq(cfg.get_value("params", "trim"), true)
	assert_eq(cfg.get_value("params", "padding"), 1)


func test_plugin_script_is_present_and_loads() -> void:
	# The plugin script extends EditorImportPlugin, which a non-editor run cannot instantiate, so
	# only check that the file exists and its text declares the contract values.
	var text := FileAccess.get_file_as_string("res://addons/pixel_forge/import_plugin.gd")
	assert_string_contains(text, 'return "Resource"')
	assert_string_contains(text, 'PackedStringArray(["pxf"])')
	assert_string_contains(text, 'return "res"')


func test_import_options() -> void:
	var names: Array[String] = []
	var defaults: Dictionary = {}
	for o: Dictionary in Import.import_options():
		names.append(o["name"])
		defaults[o["name"]] = o["default_value"]
	assert_eq(names, ["animations", "skins", "trim", "padding"] as Array[String])
	assert_eq(defaults, S.Asset.DEFAULT_OPTIONS, "the dock defaults are the builder defaults")


func test_the_addon_is_versioned() -> void:
	var cfg := ConfigFile.new()
	assert_eq(cfg.load("res://addons/pixel_forge/plugin.cfg"), OK)
	assert_eq(String(cfg.get_value("plugin", "version", "")).count("."), 2, "major.minor.patch")
	assert_eq(cfg.get_value("plugin", "script"), "plugin.gd")


func test_imported_resource_is_a_pixel_forge_asset() -> void:
	var asset: Resource = load(S.WALKER)
	assert_not_null(asset, "load() of a .pxf returns the imported resource")
	assert_eq(asset.get_script(), S.Asset)
	var a := asset as PixelForgeAsset
	assert_not_null(a)
	assert_eq(a.frames.size(), 9)
	assert_eq(a.origin, Vector2i(12, 23))
	assert_eq(a.canvas_size, Vector2i(24, 24))
	assert_eq(a.skins, PackedStringArray(["base"]))
	assert_true(a.has_animation(&"walk", &"down"))


func test_imported_resource_equals_a_direct_build() -> void:
	for pxf in [S.WALKER, S.SKINS]:
		var imported := load(pxf) as PixelForgeAsset
		var direct := S.build(pxf)
		assert_eq(imported.frames, direct.frames, "%s frames" % pxf)
		assert_eq(imported.animations, direct.animations, "%s animations" % pxf)
		assert_eq(imported.markers, direct.markers)
		assert_eq(imported.events, direct.events)
		assert_eq(imported.root_motion, direct.root_motion)
		assert_eq(imported.direction_fallback, direct.direction_fallback)
		assert_eq(imported.skins, direct.skins)
		assert_eq(imported.canvas_size, direct.canvas_size)
		assert_eq(imported.pixels_per_unit, direct.pixels_per_unit)
		assert_eq(imported.atlases.keys(), direct.atlases.keys())
		for skin: StringName in direct.atlases:
			assert_eq(
				imported.atlases[skin].get_image().get_data(),
				direct.atlases[skin].get_image().get_data(),
				"%s atlas %s" % [pxf, skin]
			)


func test_names_are_string_names_after_the_round_trip() -> void:
	var a := load(S.WALKER) as PixelForgeAsset
	assert_true(a.animations.has(&"walk"))
	assert_true(a.has_marker(4, &"ball"))
	assert_eq(a.resolve(&"walk", &"left")["direction"], &"left")


func test_textures_are_embedded_in_the_resource() -> void:
	var a := load(S.WALKER) as PixelForgeAsset
	for skin: StringName in a.atlases:
		var tex: Texture2D = a.atlases[skin]
		assert_true(tex is ImageTexture)
		assert_string_contains(tex.resource_path, "::", "a sub-resource of the .res, not a separate file")
		assert_true(tex.resource_path.begins_with(a.resource_path))


func test_import_run_with_options() -> void:
	var save_path := "user://pf_import_test"
	_made.append(save_path + ".res")
	var options := {"animations": "idle", "skins": "", "trim": false, "padding": 0}
	assert_eq(Import.run(S.WALKER, save_path, options), OK)
	var a := ResourceLoader.load(save_path + ".res", "", ResourceLoader.CACHE_MODE_IGNORE) as PixelForgeAsset
	assert_not_null(a)
	assert_eq(a.animations.keys(), [&"idle"])
	for f: Dictionary in a.frames:
		assert_eq(f["region"].size, Vector2i(24, 24), "trim off")
		assert_eq(f["offset_px"], Vector2i.ZERO)
	assert_eq(S.canvas_frame(a, &"base", 0).get_data(), S.zip_png(S.WALKER, "base", "idle/default/0.png").get_data())


func test_import_run_reports_a_bad_file() -> void:
	var save_path := "user://pf_import_bad"
	_made.append(save_path + ".res")
	var err := Import.run("res://project.godot", save_path, S.Asset.DEFAULT_OPTIONS)
	assert_ne(err, OK)
	assert_push_error("Pixel Forge")
	assert_false(FileAccess.file_exists(save_path + ".res"))


func test_import_run_reports_a_filter_that_matches_nothing() -> void:
	var save_path := "user://pf_import_none"
	_made.append(save_path + ".res")
	assert_eq(Import.run(S.WALKER, save_path, {"animations": "nope"}), ERR_INVALID_DATA)
	assert_push_warning("nope")
	assert_push_error("no animation")
