@tool
extends EditorPlugin
## Registers the `.pxf` import plugin while the addon is enabled.

const _ImportPlugin := preload("import_plugin.gd")

var _import_plugin: EditorImportPlugin = null


func _enter_tree() -> void:
	_import_plugin = _ImportPlugin.new()
	add_import_plugin(_import_plugin)


func _exit_tree() -> void:
	if _import_plugin != null:
		remove_import_plugin(_import_plugin)
		_import_plugin = null
