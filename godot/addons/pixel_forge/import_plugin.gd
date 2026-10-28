@tool
extends EditorImportPlugin
## Imports `.pxf` files as a `PixelForgeAsset` (FR-GD-01, FR-GD-04).
##
## The saved resource is a plain `Resource` (`_get_resource_type()`) whose script is
## `PixelForgeAsset`; the atlas textures are embedded in the `.res`. Godot re-imports a file
## automatically when it changes on disk. The work is done by `PixelForgeImport.run()`.

const _Import := preload("pixel_forge_import.gd")


func _get_importer_name() -> String:
	return "pixel_forge.pxf"


func _get_visible_name() -> String:
	return "Pixel Forge Asset"


func _get_recognized_extensions() -> PackedStringArray:
	return PackedStringArray(["pxf"])


func _get_save_extension() -> String:
	return "res"


func _get_resource_type() -> String:
	return "Resource"


func _get_priority() -> float:
	return 1.0


func _get_import_order() -> int:
	return 0


func _get_preset_count() -> int:
	return 1


func _get_preset_name(_preset_index: int) -> String:
	return "Default"


func _get_import_options(_path: String, _preset_index: int) -> Array[Dictionary]:
	return _Import.import_options()


func _get_option_visibility(_path: String, _option_name: StringName, _options: Dictionary) -> bool:
	return true


func _import(
	source_file: String,
	save_path: String,
	options: Dictionary,
	_platform_variants: Array[String],
	_gen_files: Array[String]
) -> Error:
	return _Import.run(source_file, save_path, options)
