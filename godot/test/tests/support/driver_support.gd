extends RefCounted
## Shared helpers for the PixelForgeDriver tests: a synthetic asset with hand-chosen durations, a
## recorder for the driver's signals, and stand-ins for the lit billboard node.

const Asset := preload("res://addons/pixel_forge/pixel_forge_asset.gd")

## Origin pixel and scale of the synthetic asset.
const ORIGIN := Vector2i(8, 15)
const PPU := 16.0


## An asset with these animations. Every frame gets the event `<tag><local index>` (so the event
## stream names the frame that fired it) and a marker `m` at `(ox + 1 + n, oy - 2n)` for its global
## index `n`, and root motion `(n + 1, -n)`.
##
##   group  direction  loop      durations (ms)         tag  mirror
##   lin    default    loop      125 250 125            l
##   once   default    once      125 250 125            o
##   pp     default    pingpong  125 250 125 250        p
##   one    default    pingpong  200                    s
##   dirs   side       loop      125 250                a
##   dirs   up         loop      125 125 250            u
##   dirs   left       loop      (frames of side)       -    mirror of side
##   dirs   right      loop      60 60                  r    (a mirror with overrides: own frames)
##
## `dirs` has `direction_fallback = {down: [down, side]}`. Frame `n` has the region
## `(4n, 0, 4, 4)` of a 256x16 atlas (`base`; `alt` is a second skin with the same layout).
static func make_asset() -> PixelForgeAsset:
	var a := Asset.new()
	a.origin = ORIGIN
	a.pixels_per_unit = PPU
	a.canvas_size = Vector2i(16, 16)
	a.skins = PackedStringArray(["base", "alt"])
	var base := Image.create_empty(256, 16, false, Image.FORMAT_RGBA8)
	base.fill(Color.WHITE)
	var alt := Image.create_empty(256, 16, false, Image.FORMAT_RGBA8)
	alt.fill(Color.BLACK)
	a.atlases = {&"base": ImageTexture.create_from_image(base), &"alt": ImageTexture.create_from_image(alt)}
	a.direction_fallback = {&"down": PackedStringArray(["down", "side"])}
	_add(a, &"lin", &"default", &"loop", [125, 250, 125], "l")
	_add(a, &"once", &"default", &"once", [125, 250, 125], "o")
	_add(a, &"pp", &"default", &"pingpong", [125, 250, 125, 250], "p")
	_add(a, &"one", &"default", &"pingpong", [200], "s")
	var side := _add(a, &"dirs", &"side", &"loop", [125, 250], "a")
	_add(a, &"dirs", &"up", &"loop", [125, 125, 250], "u")
	_entry(a, &"dirs", &"left", &"loop", side, true)
	_add(a, &"dirs", &"right", &"loop", [60, 60], "r")
	return a


static func _add(
	a: PixelForgeAsset, group: StringName, dir: StringName, loop: StringName, durs: Array, tag: String
) -> PackedInt32Array:
	var ids := PackedInt32Array()
	for i in durs.size():
		var n := a.frames.size()
		a.frames.append({"region": Rect2i(4 * n, 0, 4, 4), "offset_px": Vector2i.ZERO, "duration_ms": durs[i]})
		a.markers.append({&"m": Vector2i(ORIGIN.x + 1 + n, ORIGIN.y - 2 * n)})
		a.events.append(PackedStringArray(["%s%d" % [tag, i]]))
		a.root_motion.append(Vector2i(n + 1, -n))
		ids.append(n)
	_entry(a, group, dir, loop, ids, false)
	return ids


static func _entry(
	a: PixelForgeAsset, group: StringName, dir: StringName, loop: StringName, ids: PackedInt32Array, mirror: bool
) -> void:
	if not a.animations.has(group):
		a.animations[group] = {}
	a.animations[group][dir] = {"frames": ids, "loop": loop, "mirror": mirror}


## A driver on a `Sprite2D` with a MANUAL clock, playing `group` (optionally). The caller frees both
## through GUT's `add_child_autofree`.
static func make_driver(asset: PixelForgeAsset) -> PixelForgeDriver:
	var d := PixelForgeDriver.new()
	d.clock_mode = PixelForgeDriver.ClockMode.MANUAL
	d.asset = asset
	return d


## Records the driver's signals in order: `e:<name>`, `fc:<index>`, `finished`.
class Log:
	extends RefCounted
	var items: Array[String] = []

	func _init(d: PixelForgeDriver) -> void:
		d.event.connect(func(n: StringName) -> void: items.append("e:%s" % n))
		d.frame_changed.connect(func(i: int) -> void: items.append("fc:%d" % i))
		d.finished.connect(func() -> void: items.append("finished"))

	func take() -> Array[String]:
		var out := items.duplicate()
		items.clear()
		return out
