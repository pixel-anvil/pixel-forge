extends GutTest
## PixelForgeDriver timeline (contract section 3.3) with a MANUAL clock and uneven durations, worked by
## hand. See support/driver_support.gd for the animations. All times are chosen so that float
## sums are exact (125 ms = 0.125 s).

const S := preload("res://tests/support/driver_support.gd")

var asset: PixelForgeAsset
var driver: PixelForgeDriver


func before_all() -> void:
	asset = S.make_asset()


func before_each() -> void:
	driver = S.make_driver(asset)
	add_child_autofree(driver)


## The animation frame shown after seeking to `t` (no events).
func _frame_at(group: StringName, t: float) -> int:
	assert_true(driver.play(group, &"default", true))
	driver.seek_ms(t, false)
	return driver.frame


func test_loop_frames_and_wrap() -> void:
	# lin: frames start at 0, 125, 375; one pass is 500 ms
	var expected := {0.0: 0, 124.0: 0, 125.0: 1, 374.0: 1, 375.0: 2, 499.0: 2, 500.0: 0, 625.0: 1, 1374.0: 1, 1375.0: 2}
	for t: float in expected:
		assert_eq(_frame_at(&"lin", t), expected[t], "loop at %s ms" % t)


func test_once_holds_the_last_frame_and_finishes() -> void:
	var expected := {0.0: 0, 125.0: 1, 375.0: 2, 499.0: 2, 500.0: 2, 99999.0: 2}
	for t: float in expected:
		assert_eq(_frame_at(&"once", t), expected[t], "once at %s ms" % t)
	assert_true(driver.is_finished())
	_frame_at(&"once", 499.0)
	assert_false(driver.is_finished())


func test_pingpong_sequence_has_its_own_durations() -> void:
	# pp: 0 1 2 3 2 1, entries start at 0 125 375 500 750 875, cycle 1125 ms
	var expected := {
		0.0: 0, 125.0: 1, 375.0: 2, 500.0: 3, 749.0: 3, 750.0: 2, 874.0: 2, 875.0: 1, 1124.0: 1,
		1125.0: 0, 1250.0: 1, 1500.0: 2, 1625.0: 3, 2250.0: 0,
	}
	for t: float in expected:
		assert_eq(_frame_at(&"pp", t), expected[t], "pingpong at %s ms" % t)


func test_pingpong_with_one_frame_is_a_loop() -> void:
	for t: float in [0.0, 199.0, 200.0, 12345.0]:
		assert_eq(_frame_at(&"one", t), 0)


func test_advance_moves_by_milliseconds_and_accumulates_exactly() -> void:
	driver.play(&"lin")
	driver.advance(0.0625)  # 62.5 ms
	assert_eq(driver.position_ms, 62.5)
	assert_eq(driver.frame, 0)
	driver.advance(0.0625)
	assert_eq(driver.position_ms, 125.0)
	assert_eq(driver.frame, 1, "frame 1 starts exactly at 125 ms")
	assert_eq(driver.frame_index, 1)


func test_frame_progress() -> void:
	driver.play(&"lin")
	assert_eq(driver.frame_progress(), 0.0)
	driver.seek_ms(125.0 + 62.5)  # a quarter into the 250 ms frame
	assert_eq(driver.frame_progress(), 0.25)
	driver.seek_ms(499.5)
	assert_almost_eq(driver.frame_progress(), 124.5 / 125.0, 1e-9)
	assert_lt(driver.frame_progress(), 1.0)
	# pingpong, on the way back: entry 4 (frame 2) starts at 750 and lasts 125
	driver.play(&"pp", &"default", true)
	driver.seek_ms(750.0 + 25.0)
	assert_eq(driver.frame, 2)
	assert_eq(driver.frame_progress(), 0.2)


func test_frame_progress_is_one_at_the_end_of_once_and_while_held() -> void:
	driver.play(&"once")
	driver.seek_ms(9999.0)
	assert_eq(driver.frame_progress(), 1.0)
	driver.play(&"lin")
	driver.hold_last = true
	driver.seek_ms(9999.0)
	assert_eq(driver.position_ms, 500.0, "held at the end of the first pass")
	assert_eq(driver.frame_progress(), 1.0)


func test_hold_last_on_a_loop() -> void:
	driver.play(&"lin")
	driver.hold_last = true
	driver.advance(10.0)
	assert_eq(driver.position_ms, 500.0, "the position never passes T")
	assert_eq(driver.frame, 2)
	assert_true(driver.is_finished())
	driver.advance(1.0)
	assert_eq(driver.position_ms, 500.0)
	assert_eq(driver.frame, 2)


func test_hold_last_on_a_pingpong() -> void:
	driver.play(&"pp")
	driver.hold_last = true
	driver.advance(10.0)
	assert_eq(driver.position_ms, 750.0, "T of the pingpong is the end of the forward pass")
	assert_eq(driver.frame, 3)
	assert_true(driver.is_finished())


func test_hold_last_on_once_changes_nothing() -> void:
	driver.play(&"once")
	driver.hold_last = true
	driver.advance(10.0)
	assert_eq(driver.frame, 2)
	assert_eq(driver.position_ms, 500.0)


func test_clearing_hold_last_resumes_a_loop_at_frame_0() -> void:
	driver.play(&"lin")
	driver.hold_last = true
	driver.advance(10.0)
	driver.hold_last = false
	assert_eq(driver.frame, 2, "clearing alone does not move the frame")
	assert_eq(driver.position_ms, 500.0)
	driver.advance(0.0625)  # 562.5 ms: 62.5 ms into frame 0 of the next pass
	assert_eq(driver.frame, 0)
	driver.advance(0.0625)  # 625 ms
	assert_eq(driver.frame, 1)


func test_clearing_hold_last_resumes_a_pingpong_at_frame_n_minus_2() -> void:
	driver.play(&"pp")
	driver.hold_last = true
	driver.advance(10.0)
	driver.hold_last = false
	driver.advance(0.0625)  # 812.5 ms: inside entry 4 (750..875), frame n-2 = 2
	assert_eq(driver.frame, 2)
	driver.advance(0.0625)  # 875
	assert_eq(driver.frame, 1)


func test_clearing_hold_last_leaves_once_finished() -> void:
	driver.play(&"once")
	driver.hold_last = true
	driver.advance(10.0)
	driver.hold_last = false
	driver.advance(1.0)
	assert_eq(driver.frame, 2)
	assert_true(driver.is_finished())


func test_setting_hold_last_past_the_end_jumps_to_the_last_frame() -> void:
	driver.play(&"lin")
	driver.seek_ms(1250.0)  # frame 1 of the third pass
	assert_eq(driver.frame, 1)
	driver.hold_last = true
	assert_eq(driver.position_ms, 500.0)
	assert_eq(driver.frame, 2)


func test_paused_stops_the_clock_but_not_seek_or_set_frame() -> void:
	driver.play(&"lin")
	driver.paused = true
	driver.advance(1.0)
	assert_eq(driver.position_ms, 0.0)
	driver.seek_ms(130.0)
	assert_eq(driver.frame, 1)
	assert_eq(driver.position_ms, 130.0)
	driver.set_frame(2)
	assert_eq(driver.frame, 2)
	assert_eq(driver.position_ms, 375.0)
	driver.paused = false
	driver.advance(0.125)
	assert_eq(driver.position_ms, 500.0)
	assert_eq(driver.frame, 0)


func test_seek_clamps_negative_time() -> void:
	driver.play(&"lin")
	driver.seek_ms(300.0)
	driver.seek_ms(-50.0)
	assert_eq(driver.position_ms, 0.0)
	assert_eq(driver.frame, 0)


func test_set_frame_clamps_and_uses_the_first_occurrence_in_a_pingpong() -> void:
	driver.play(&"pp")
	driver.set_frame(3)
	assert_eq(driver.position_ms, 500.0)
	driver.set_frame(1)
	assert_eq(driver.position_ms, 125.0, "frame 1 of pp starts at 125 ms on the way up")
	driver.set_frame(99)
	assert_eq(driver.frame, 3, "clamped to n-1")
	driver.set_frame(-4)
	assert_eq(driver.frame, 0)


func test_clock_modes_choose_the_processing_callbacks() -> void:
	var d := PixelForgeDriver.new()
	add_child_autofree(d)
	assert_true(d.is_processing())
	assert_false(d.is_physics_processing())
	d.clock_mode = PixelForgeDriver.ClockMode.PHYSICS
	assert_false(d.is_processing())
	assert_true(d.is_physics_processing())
	d.clock_mode = PixelForgeDriver.ClockMode.MANUAL
	assert_false(d.is_processing())
	assert_false(d.is_physics_processing())


func test_idle_clock_drives_the_driver_from_process() -> void:
	var d := PixelForgeDriver.new()
	d.asset = asset
	add_child_autofree(d)
	d.play(&"lin")
	d._process(0.125)  # what the engine calls in IDLE mode
	assert_eq(d.frame, 1)
	d.clock_mode = PixelForgeDriver.ClockMode.PHYSICS
	d._physics_process(0.25)
	assert_eq(d.position_ms, 375.0)
	assert_eq(d.frame, 2)


func test_nothing_playing_is_harmless() -> void:
	driver.advance(1.0)
	driver.seek_ms(10.0)
	driver.set_frame(1)
	assert_eq(driver.frame, -1)
	assert_eq(driver.frame_index, -1)
	assert_eq(driver.group, &"")
	assert_eq(driver.frame_progress(), 0.0)
	assert_false(driver.has_marker(&"m"))
	assert_eq(driver.marker(&"m"), Vector2.ZERO)
	assert_eq(driver.frame_events(), PackedStringArray())
	assert_eq(driver.root_motion(), Vector2i.ZERO)


func test_setting_the_asset_stops_playback() -> void:
	driver.play(&"lin")
	driver.asset = S.make_asset()
	assert_eq(driver.group, &"")
	assert_eq(driver.frame, -1)
	driver.advance(1.0)
	assert_eq(driver.frame, -1)
