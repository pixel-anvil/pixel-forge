class_name PixelForgeSpriteCommon
extends RefCounted
## Shared logic of `PixelForgeSprite2D` and `PixelForgeSprite3D` (FR-GD-06, E8.2): the `SpriteFrames`
## cache per direction, the flip rule and the origin anchor. GDScript has no mixins, so the two nodes
## call these static functions.


## `SpriteFrames` for `direction`, built once per (asset, skin) in `cache` (`{direction: SpriteFrames}`).
## Null when the asset or the skin is unusable.
static func frames_for(
	cache: Dictionary, asset: PixelForgeAsset, skin: StringName, direction: StringName
) -> SpriteFrames:
	if asset == null:
		return null
	if not cache.has(direction):
		var sf := PixelForgeSpriteFrames.build(asset, direction, skin)
		if sf == null:
			return null
		cache[direction] = sf
	return cache[direction]


## The `flip_h` a node needs for `animation`: the node's `mirror` XOR the animation's `mirrorOf`.
static func flip_for(sf: SpriteFrames, animation: StringName, mirror: bool) -> bool:
	if sf == null:
		return mirror
	return mirror != PixelForgeSpriteFrames.is_mirrored(sf, animation)


## The sprite `offset`, in pixels, y down, that puts the origin point on the node origin. Frames are
## canvas sized and centred, so the canvas centre moves to the origin point (contract section 6.3
## for `pixel_edge_origin`). `flip_h` flips the picture inside the same rectangle and does not
## mirror `offset` (contract section 8.1), so x is negated for a flipped node.
static func anchor_offset(asset: PixelForgeAsset, flipped: bool, pixel_edge_origin: bool) -> Vector2:
	if asset == null:
		return Vector2.ZERO
	var ox := float(asset.origin.x) + (0.0 if pixel_edge_origin else 0.5)
	var dx := asset.canvas_size.x / 2.0 - ox
	var dy := asset.canvas_size.y / 2.0 - (float(asset.origin.y) + 1.0)
	return Vector2(-dx if flipped else dx, dy)
