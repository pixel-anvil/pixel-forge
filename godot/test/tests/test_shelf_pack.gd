extends GutTest
## Shelf packing: no overlaps, everything inside the atlas, deterministic.

const Asset := preload("res://addons/pixel_forge/pixel_forge_asset.gd")


func _check(sizes: Array[Vector2i]) -> Dictionary:
	var packed := Asset.shelf_pack(sizes)
	var positions: Array[Vector2i] = packed["positions"]
	var atlas: Vector2i = packed["size"]
	assert_eq(positions.size(), sizes.size())
	for i in sizes.size():
		var a := Rect2i(positions[i], sizes[i])
		assert_true(Rect2i(Vector2i.ZERO, atlas).encloses(a), "rect %d inside the atlas" % i)
		for j in range(i + 1, sizes.size()):
			assert_false(a.intersects(Rect2i(positions[j], sizes[j])), "rects %d and %d overlap" % [i, j])
	return packed


func test_four_equal_squares_share_one_shelf() -> void:
	var sizes: Array[Vector2i] = [Vector2i(4, 4), Vector2i(4, 4), Vector2i(4, 4), Vector2i(4, 4)]
	var packed := _check(sizes)
	assert_eq(packed["size"], Vector2i(16, 4))
	assert_eq(packed["positions"], [Vector2i(0, 0), Vector2i(4, 0), Vector2i(8, 0), Vector2i(12, 0)] as Array[Vector2i])


func test_taller_rectangles_go_first_and_ties_keep_input_order() -> void:
	var sizes: Array[Vector2i] = [Vector2i(2, 2), Vector2i(2, 6), Vector2i(2, 2)]
	var packed := Asset.shelf_pack(sizes)
	var p: Array[Vector2i] = packed["positions"]
	assert_eq(p[1], Vector2i(0, 0), "tallest first")
	assert_eq(p[0], Vector2i(2, 0))
	assert_eq(p[2], Vector2i(4, 0))


func test_wraps_to_a_new_shelf_at_the_width() -> void:
	var sizes: Array[Vector2i] = []
	for i in 6:
		sizes.append(Vector2i(10, 5))
	var packed := Asset.shelf_pack(sizes)
	assert_eq(packed["size"], Vector2i(32, 10), "3 per shelf in a 32 wide atlas, 2 shelves")
	# a narrower limit forces one rectangle per shelf
	packed = Asset.shelf_pack(sizes, 16)
	assert_eq(packed["size"], Vector2i(16, 30), "6 shelves of 5")


func test_random_sets_never_overlap_and_are_deterministic() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = 6
	for round in 20:
		var sizes: Array[Vector2i] = []
		for i in rng.randi_range(1, 60):
			sizes.append(Vector2i(rng.randi_range(1, 70), rng.randi_range(1, 70)))
		var a := _check(sizes)
		var b := Asset.shelf_pack(sizes)
		assert_eq(a, b, "same input, same layout")


func test_a_rectangle_wider_than_the_preferred_width_widens_the_atlas() -> void:
	var sizes: Array[Vector2i] = [Vector2i(5000, 3), Vector2i(10, 10)]
	var packed := _check(sizes)
	var atlas: Vector2i = packed["size"]
	assert_gte(atlas.x, 5000)


func test_empty_input() -> void:
	var packed := Asset.shelf_pack([] as Array[Vector2i])
	assert_eq(packed["positions"], [] as Array[Vector2i])
	assert_eq(packed["size"], Vector2i(1, 1))
