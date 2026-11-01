class_name PixelForgeDriver
extends Node
## The single clock of a pixel-forge animation (FR-GD-03). It plays a `PixelForgeAsset` on one target
## node through an adapter, emits `event`, `finished` and `frame_changed`, and answers marker,
## event and root-motion queries about the displayed frame.
##
## The contract for every property, method, timeline and event rule is
## docs/contracts/GODOT_INTEGRATION.md sections 3 and 4. The notes below only cover what the
## contract leaves to the implementation.
##
## Time model: the driver keeps `position_ms` as a float. For the resolved animation it builds one
## cycle of "entries" (a frame index plus its duration): `0..n-1` for `once` and `loop`, and
## `0..n-1, n-2..1` for `pingpong`. Every entry the clock enters has an absolute id (cycle count
## times entries per cycle plus the entry's place), so a long `advance()` can fire the events of
## every crossed entry in order and never drops one.

## When the clock runs: `IDLE` in `_process`, `PHYSICS` in `_physics_process`, `MANUAL` only through
## `advance()`.
enum ClockMode { IDLE, PHYSICS, MANUAL }

## Emitted when a frame starts being displayed, once per event name of the frame, in authored order.
signal event(event_name: StringName)
## Emitted once per `play()` when the position reaches the end of a `once` animation, or when
## `hold_last` stops the position there.
signal finished
## Emitted when the displayed frame changes; `index` is the index within the animation, after the
## adapter has applied the frame.
signal frame_changed(index: int)

## The imported asset. Setting it stops playback until `play()`.
@export var asset: PixelForgeAsset = null:
	set = _set_asset
## Atlas to use. Changing it re-applies the frame (no event, no `frame_changed`).
@export var skin: StringName = &"base":
	set = _set_skin
## Set by the game. Changing it re-resolves the current group at the same position and fires no
## events; `frame_changed` is emitted if the picture changes.
@export var direction: StringName = &"default":
	get = get_direction, set = set_direction
## `0` off; `4` or `8` derives `direction` and `mirror` from the camera sector each time the clock
## ticks (see `sector_direction` and `update_auto_direction`). With it on, the driver owns
## `direction` and `mirror`.
@export_enum("Off:0", "4 sectors:4", "8 sectors:8") var auto_direction: int = 0
## A game-requested horizontal mirror. The applied flip is `mirror XOR` the animation's mirror flag.
@export var mirror: bool = false:
	set = _set_mirror
## `true` stops the clock. The frame stays and is re-applied when `skin`, `direction` or `mirror`
## change; `seek_ms` and `set_frame` still work.
@export var paused: bool = false
## `true`: stop on the last frame of the first forward pass, whatever the loop mode.
@export var hold_last: bool = false:
	set = _set_hold_last
@export var clock_mode: ClockMode = ClockMode.IDLE:
	set = _set_clock_mode

## The node to drive. Setting it chooses the adapter (`Sprite2D`, `Sprite3D`, else duck-typed)
## unless a custom `adapter` was assigned, and applies the current frame.
var target: Node = null:
	set = _set_target
## The adapter in use. Assign a `PixelForgeAdapter` (for the duck-typed options `offset_y_up` and
## `apply_pixel_size`, or a subclass) after setting `target`; the driver keeps it when `target` changes.
var adapter: PixelForgeAdapter:
	get:
		return _adapter
	set(value):
		_adapter = value
		_custom_adapter = value != null
		_apply()
## Optional camera for `auto_direction`; `null` uses the viewport's current 3D camera.
var auto_direction_camera: Node3D = null

## The group being played, `&""` when nothing is.
var group: StringName:
	get:
		return _group
## Index within the resolved animation, `0..n-1`; `-1` when nothing is playing.
var frame: int:
	get:
		return _anim_frame
## Index into `asset.frames` of the displayed frame; `-1` when nothing is playing.
var frame_index: int:
	get:
		return -1 if _anim_frame < 0 else _frame_ids[_anim_frame]
## Play position in milliseconds on the current animation's timeline.
var position_ms: float:
	get:
		return _pos

var _direction: StringName = &"default"
var _adapter: PixelForgeAdapter = null
var _custom_adapter := false
var _group: StringName = &""
var _entry: Dictionary = {}
var _frame_ids := PackedInt32Array()  # asset frame index per animation frame
var _durs := PackedInt32Array()  # duration_ms per animation frame
var _starts := PackedInt32Array()  # start of each animation frame in one forward pass
var _seq := PackedInt32Array()  # animation frame per entry of one cycle
var _seq_starts := PackedInt32Array()  # start of each entry within a cycle
var _cycle := 0  # ms of one cycle
var _total := 0  # T: ms of one forward pass
var _repeating := false
var _pos := 0.0
var _entry_id := 0  # absolute id of the displayed entry
var _anim_frame := -1
var _finished := false
var _epoch := 0  # bumped by play, seek and jumps so an interrupted step can stop


func _init() -> void:
	_update_processing()


func _ready() -> void:
	# Godot turns both callbacks on when the node enters the tree; apply the clock mode again.
	_update_processing()


func _process(delta: float) -> void:
	advance(delta)


func _physics_process(delta: float) -> void:
	advance(delta)


# ---------------------------------------------------------------------------------------------
# Playback
# ---------------------------------------------------------------------------------------------


## Plays `group_name` in `direction_name` (empty: the current `direction`), which also sets
## `direction`. When the resolved entry (group, direction found) is already playing and `restart`
## is false nothing changes. Otherwise the position goes to 0, frame 0 is applied and its events
## fire. Returns false, pushes an error and keeps the current animation when nothing resolves.
func play(group_name: StringName, direction_name: StringName = &"", restart: bool = false) -> bool:
	if asset == null:
		push_error("PixelForgeDriver.play: no asset")
		return false
	var d := direction_name if direction_name != &"" else _direction
	var entry := asset.resolve(group_name, d)
	if entry.is_empty():
		push_error("PixelForgeDriver.play: no animation '%s' for direction '%s'" % [group_name, d])
		return false
	_direction = d
	if not restart and _is_playing_entry(group_name, entry):
		return true
	var same := _is_playing_entry(group_name, entry) and _anim_frame == 0
	_epoch += 1
	var ep := _epoch
	_group = group_name
	_set_entry(entry)
	_pos = 0.0
	_entry_id = 0
	_anim_frame = 0
	_finished = false
	_apply()
	if not same:
		frame_changed.emit(0)
		if ep != _epoch:
			return true
	_fire_events(frame_index, ep)
	return true


## Sets `position_ms = max(t, 0)` (clamped to the end of the forward pass under `hold_last`) and
## applies the frame. Fires only the target frame's events, and only if the displayed frame changes
## (contract section 4.2, rule 4).
func seek_ms(t: float, emit_events: bool = true) -> void:
	if _anim_frame < 0:
		return
	t = maxf(t, 0.0)
	if hold_last:
		t = minf(t, float(_total))
	_jump(t, emit_events)


## Jumps to the start of frame `i` (clamped to `0..n-1`; its first occurrence for `pingpong`).
func set_frame(i: int, emit_events: bool = true) -> void:
	if _anim_frame < 0:
		return
	_jump(float(_starts[clampi(i, 0, _frame_ids.size() - 1)]), emit_events)


## Adds `delta_s * 1000` to `position_ms` unless `paused`. In `IDLE` and `PHYSICS` mode the driver
## calls this itself. Every crossed frame's events fire, in timeline order; the intermediate ones
## fire before the final frame is applied, and `frame_changed` fires once for the frame finally
## displayed (so a handler that queries the displayed frame during an intermediate event sees the
## old one).
func advance(delta_s: float) -> void:
	update_auto_direction()
	if paused or _anim_frame < 0 or delta_s <= 0.0:
		return
	var t := _pos + delta_s * 1000.0
	if hold_last:
		t = minf(t, float(_total))
	_pos = t
	var new_id := _id_at(t)
	if new_id > _entry_id:
		var ep := _epoch
		for id in range(_entry_id + 1, new_id):
			if not _fire_events(_frame_ids[_seq[id % _seq.size()]], ep):
				return
		_entry_id = new_id
		var nf := _seq[new_id % _seq.size()]
		if nf != _anim_frame:
			_anim_frame = nf
			_apply()
			frame_changed.emit(nf)
			if ep != _epoch:
				return
		if not _fire_events(_frame_ids[nf], ep):
			return
	_check_finished()


## `(t - start_i) / d_i` within the displayed frame, in `[0, 1)`; `1.0` while held on the last frame
## by `hold_last` or at the end of a `once` animation. `0.0` when nothing is playing.
func frame_progress() -> float:
	if _anim_frame < 0:
		return 0.0
	var d := float(_durs[_seq[_entry_id % _seq.size()]])
	return clampf((_pos - float(_entry_start(_entry_id))) / d, 0.0, 1.0)


## Whether the animation is over: `once` at or past its end, or `hold_last` stopped at the end.
func is_finished() -> bool:
	return _anim_frame >= 0 and _pos >= float(_total) and (not _repeating or hold_last)


## The applied flip: `mirror XOR` the resolved animation's mirror flag.
func is_flipped() -> bool:
	return mirror != bool(_entry.get("mirror", false))


# ---------------------------------------------------------------------------------------------
# Queries about the displayed frame
# ---------------------------------------------------------------------------------------------


## Whether the displayed frame has the marker `marker_name`.
func has_marker(marker_name: StringName) -> bool:
	return _anim_frame >= 0 and asset.has_marker(frame_index, marker_name)


## The marker in pixels, y down, relative to the origin point, x negated when flipped (contract
## section 6.1). `Vector2.ZERO` when absent.
func marker(marker_name: StringName) -> Vector2:
	if _anim_frame < 0:
		return Vector2.ZERO
	return asset.marker_px(frame_index, marker_name, is_flipped())


## The marker in metres, y up, relative to the origin point (the node's origin), flipped when
## `is_flipped()`. `Vector2.ZERO` when absent.
func marker_metres(marker_name: StringName) -> Vector2:
	if _anim_frame < 0:
		return Vector2.ZERO
	return asset.marker_metres(frame_index, marker_name, is_flipped())


## Event names of the displayed frame (the event-as-flag query, contract section 4.3).
func frame_events() -> PackedStringArray:
	if _anim_frame < 0:
		return PackedStringArray()
	return asset.events[frame_index]


## `root_motion` of the displayed frame, `dx` negated when flipped.
func root_motion() -> Vector2i:
	if _anim_frame < 0:
		return Vector2i.ZERO
	var rm: Vector2i = asset.root_motion[frame_index]
	return Vector2i(-rm.x if is_flipped() else rm.x, rm.y)


## The centre of the displayed region relative to the origin point, pixels, y down, already flipped
## (the `offset` passed to the adapter, contract section 8.1).
func frame_offset() -> Vector2:
	if _anim_frame < 0:
		return Vector2.ZERO
	var f: Dictionary = asset.frames[frame_index]
	var region: Rect2i = f["region"]
	var top_left: Vector2i = f["offset_px"]
	var s := -1.0 if is_flipped() else 1.0
	return Vector2(
		s * (top_left.x + region.size.x / 2.0 - asset.origin.x - 0.5),
		top_left.y + region.size.y / 2.0 - asset.origin.y - 1.0
	)


# ---------------------------------------------------------------------------------------------
# auto_direction
# ---------------------------------------------------------------------------------------------


## Maps the camera's angle around the character to `{direction, mirror}`. `angle_deg` is the signed
## angle in the horizontal plane from the character's facing to the direction of the camera: 0 is a
## camera in front of the character (the character faces it: `down`), 180 is behind (`up`), and
## positive is the character's left. `count` is 4 (`down`, `side`, `up`) or 8 (adds `down_side` and
## `up_side`). Sectors are half-open, `[lo, hi)` on the absolute angle, centred on 0, 45, 90... for
## 8 and on 0, 90, 180 for 4. A side view faces right in the art, so `mirror` is true when the
## camera is on the character's left (the character then faces screen-left).
static func sector_direction(angle_deg: float, count: int) -> Dictionary:
	var signed := wrapf(angle_deg, -180.0, 180.0)
	var a := absf(signed)
	var names: Array[StringName]
	var k: int
	if count == 8:
		names = [&"down", &"down_side", &"side", &"up_side", &"up"]
		k = int(floorf((a + 22.5) / 45.0))
	else:
		names = [&"down", &"side", &"up"]
		k = int(floorf((a + 45.0) / 90.0))
	k = mini(k, names.size() - 1)
	var is_front_or_back := k == 0 or k == names.size() - 1
	return {"direction": names[k], "mirror": signed > 0.0 and not is_front_or_back}


## Derives `direction` and `mirror` from the camera (`auto_direction` 4 or 8; a `Node3D` target).
## The character's facing is the target's -Z axis. Called by `advance()`; does nothing without a
## camera or when `auto_direction` is 0.
func update_auto_direction() -> void:
	if auto_direction != 4 and auto_direction != 8:
		return
	var node3 := target as Node3D
	if node3 == null or not node3.is_inside_tree():
		return
	var cam := auto_direction_camera
	if cam == null and is_inside_tree():
		cam = get_viewport().get_camera_3d()
	if cam == null:
		return
	var to_cam := cam.global_position - node3.global_position
	var facing := -node3.global_basis.z
	to_cam.y = 0.0
	facing.y = 0.0
	if to_cam.length_squared() < 1e-12 or facing.length_squared() < 1e-12:
		return
	var angle := rad_to_deg(facing.signed_angle_to(to_cam, Vector3.UP))
	var r := sector_direction(angle, auto_direction)
	mirror = r["mirror"]
	direction = r["direction"]


# ---------------------------------------------------------------------------------------------
# Property accessors
# ---------------------------------------------------------------------------------------------


func get_direction() -> StringName:
	return _direction


func set_direction(value: StringName) -> void:
	_direction = value
	if _anim_frame < 0:
		return
	var entry := asset.resolve(_group, value)
	if entry.is_empty() or _is_playing_entry(_group, entry):
		return
	var old_anim_frame := _anim_frame
	var old_index := frame_index
	_set_entry(entry)
	if hold_last:
		_pos = minf(_pos, float(_total))
	_entry_id = _id_at(_pos)
	_anim_frame = _seq[_entry_id % _seq.size()]
	_apply()
	if _anim_frame != old_anim_frame or frame_index != old_index:
		frame_changed.emit(_anim_frame)
	_check_finished()


func _set_asset(value: PixelForgeAsset) -> void:
	asset = value
	_group = &""
	_entry = {}
	_anim_frame = -1
	_pos = 0.0
	_entry_id = 0
	_finished = false
	_epoch += 1


func _set_skin(value: StringName) -> void:
	skin = value
	_apply()


func _set_mirror(value: bool) -> void:
	mirror = value
	_apply()


func _set_hold_last(value: bool) -> void:
	hold_last = value
	if value and _anim_frame >= 0 and _pos >= float(_total):
		_jump(float(_total), false)


func _set_clock_mode(value: ClockMode) -> void:
	clock_mode = value
	_update_processing()


func _set_target(value: Node) -> void:
	target = value
	if not _custom_adapter:
		var want: Script = null
		if value is Sprite2D:
			want = PixelForgeSprite2DAdapter
		elif value is Sprite3D:
			want = PixelForgeSprite3DAdapter
		elif value != null:
			want = PixelForgeAdapter
		# keep the adapter (and any options set on it) while the node type stays the same
		if want == null:
			_adapter = null
		elif _adapter == null or _adapter.get_script() != want:
			_adapter = want.new()
	_apply()


func _update_processing() -> void:
	set_process(clock_mode == ClockMode.IDLE)
	set_physics_process(clock_mode == ClockMode.PHYSICS)


# ---------------------------------------------------------------------------------------------
# Timeline internals
# ---------------------------------------------------------------------------------------------


func _is_playing_entry(group_name: StringName, entry: Dictionary) -> bool:
	return (
		_anim_frame >= 0
		and group_name == _group
		and entry["direction"] == _entry.get("direction")
	)


## Installs `entry` and builds its timeline.
func _set_entry(entry: Dictionary) -> void:
	_entry = entry
	_frame_ids = entry["frames"]
	var n := _frame_ids.size()
	_durs = PackedInt32Array()
	_starts = PackedInt32Array()
	_total = 0
	for i in n:
		var d := int(asset.frames[_frame_ids[i]]["duration_ms"])
		_durs.append(d)
		_starts.append(_total)
		_total += d
	var loop: StringName = entry["loop"]
	_repeating = loop != &"once"
	_seq = PackedInt32Array()
	_seq_starts = PackedInt32Array()
	var at := 0
	var order: Array[int] = []
	for i in n:
		order.append(i)
	if loop == &"pingpong":
		for i in range(n - 2, 0, -1):
			order.append(i)
	for i in order:
		_seq.append(i)
		_seq_starts.append(at)
		at += _durs[i]
	_cycle = at


## Absolute id of the entry displayed at time `t` (contract section 3.3). Under `hold_last` the
## end of the first pass is entry `n-1`.
func _id_at(t: float) -> int:
	var n := _frame_ids.size()
	if t >= float(_total) and (hold_last or not _repeating):
		return n - 1
	if not _repeating:
		return _seq_index_at(t)
	var cycles := floori(t / float(_cycle))
	var p := t - float(cycles) * float(_cycle)
	if p < 0.0:
		cycles -= 1
		p += float(_cycle)
	elif p >= float(_cycle):
		cycles += 1
		p -= float(_cycle)
	return cycles * _seq.size() + _seq_index_at(p)


## Index of the entry that contains `p`, `0 <= p < cycle` (the last entry for `p` past the end).
@warning_ignore("integer_division")
func _seq_index_at(p: float) -> int:
	var lo := 0
	var hi := _seq.size() - 1
	while lo < hi:
		var mid := (lo + hi + 1) / 2
		if float(_seq_starts[mid]) <= p:
			lo = mid
		else:
			hi = mid - 1
	return lo


## Start time (ms) of the entry with absolute id `id`.
@warning_ignore("integer_division")
func _entry_start(id: int) -> int:
	var l := _seq.size()
	return (id / l) * _cycle + _seq_starts[id % l]


## Moves the position to `t` and shows the entry there. Fires the target frame's events only when
## the displayed frame changes and `emit_events` is set; never the events of frames jumped over.
func _jump(t: float, emit_events: bool) -> void:
	_epoch += 1
	var ep := _epoch
	_pos = t
	_entry_id = _id_at(t)
	var nf := _seq[_entry_id % _seq.size()]
	if nf != _anim_frame:
		_anim_frame = nf
		_apply()
		frame_changed.emit(nf)
		if ep != _epoch:
			return
		if emit_events:
			_fire_events(frame_index, ep)
			if ep != _epoch:
				return
	_check_finished()


## Emits `event` for each name of asset frame `index`. Returns false when a handler started another
## play, seek or jump (`ep` no longer current): the rest of the interrupted step is dropped.
func _fire_events(index: int, ep: int) -> bool:
	for e in asset.events[index]:
		event.emit(StringName(e))
		if ep != _epoch:
			return false
	return true


func _check_finished() -> void:
	if not _finished and is_finished():
		_finished = true
		finished.emit()


## Pushes the displayed frame to the adapter. Emits no signal.
func _apply() -> void:
	if _anim_frame < 0 or _adapter == null or target == null or not is_instance_valid(target):
		return
	var atlas: Texture2D = asset.atlases.get(skin)
	if atlas == null:
		atlas = asset.atlases.get(&"base")
	var region: Rect2i = asset.frames[frame_index]["region"]
	_adapter.node = target
	_adapter.pixels_per_unit = asset.pixels_per_unit
	_adapter.apply(atlas, region, frame_offset(), is_flipped())
