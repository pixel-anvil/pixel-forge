@tool
class_name PixelForgeImport
extends RefCounted
## The import step behind the `.pxf` import plugin, kept apart from `EditorImportPlugin` (which only
## exists inside the editor) so that it can be tested in a plain headless run.

const _Asset := preload("pixel_forge_asset.gd")
const _Reader := preload("pxf_reader.gd")


## The options the import dock shows, in `EditorImportPlugin._get_import_options()` format.
static func import_options() -> Array[Dictionary]:
	return [
		{
			"name": "animations",
			"default_value": "",
			"hint_string": "Comma-separated 'group' or 'group/direction'; empty imports all",
		},
		{
			"name": "skins",
			"default_value": "",
			"hint_string": "Comma-separated skin names; empty imports all ('base' is always imported)",
		},
		{"name": "trim", "default_value": true},
		{
			"name": "padding",
			"default_value": 1,
			"property_hint": PROPERTY_HINT_RANGE,
			"hint_string": "0,%d,1" % _Asset.MAX_PADDING,
		},
	]


## Reads `source_file`, builds the asset and saves it as `<save_path>.res` (textures embedded).
## Pushes an error and returns a non-OK code when the file is unusable.
static func run(source_file: String, save_path: String, options: Dictionary) -> Error:
	var reader := _Reader.new()
	var err := reader.open(source_file)
	if err != OK:
		push_error("Pixel Forge: %s" % reader.error_message)
		return err
	var report: Dictionary = {}
	var asset := _Asset.build(reader, options, report)
	reader.close()
	for warning: String in report.get("warnings", []):
		push_warning("Pixel Forge: %s: %s" % [source_file, warning])
	if asset == null:
		for message: String in report.get("errors", []):
			push_error("Pixel Forge: %s: %s" % [source_file, message])
		return ERR_INVALID_DATA
	return ResourceSaver.save(asset, "%s.res" % save_path)
