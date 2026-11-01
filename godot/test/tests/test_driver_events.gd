extends GutTest
## PixelForgeDriver signals and the event delivery rules (contract section 4.2). Each frame fires an
## event named after its animation's tag and its local index (`l0`, `l1`, `l2` for `lin`), so the
## log shows which frames fired. Log entries: `e:<event>`, `fc:<index>`, `finished`.

const S := preload("res://tests/support/driver_support.gd")

var asset: PixelForgeAsset
var driver: PixelForgeDriver
var rec: S.Log


func before_all() -> void:
	asset = S.make_asset()


func before_each() -> void:
	driver = S.make_driver(asset)
	add_child_autofree(driver)
	rec = S.Log.new(driver)


func test_play_fires_frame_0_events_after_frame_changed() -> void:
	driver.play(&"lin")
	assert_eq(rec.take(), ["fc:0", "e:l0"] as Array[String])


func test_a_single_step_fires_frame_changed_then_that_frames_events() -> void:
	driver.play(&"lin")
	rec.take()
	driver.advance(0.125)
	assert_eq(rec.take(), ["fc:1", "e:l1"] as Array[String])
	driver.advance(0.0625)
	assert_eq(rec.take(), [] as Array[String], "inside a frame nothing fires")


func test_a_long_advance_drops_no_event() -> void:
	# 1250 ms from frame 0: entries 1..7 are frames 1 2 0 1 2 0 1 (two wraps); one frame_changed
	driver.play(&"lin")
	rec.take()
	driver.advance(1.25)
	var want: Array[String] = ["e:l1", "e:l2", "e:l0", "e:l1", "e:l2", "e:l0", "fc:1", "e:l1"]
	assert_eq(rec.take(), want)
	assert_eq(driver.position_ms, 1250.0)


func test_every_wrap_fires_frame_0_even_when_the_frame_is_unchanged() -> void:
	driver.play(&"lin")
	rec.take()
	driver.advance(1.0)  # two full passes: back on frame 0
	var want: Array[String] = ["e:l1", "e:l2", "e:l0", "e:l1", "e:l2", "e:l0"]
	assert_eq(rec.take(), want, "no frame_changed: frame 0 is shown before and after")


func test_pingpong_fires_every_entry_in_both_directions() -> void:
	driver.play(&"pp")
	rec.take()
	driver.advance(1.125)  # one full cycle: entries 1..5 then entry 6 = frame 0 again
	var want: Array[String] = ["e:p1", "e:p2", "e:p3", "e:p2", "e:p1", "e:p0"]
	assert_eq(rec.take(), want)
	driver.advance(0.5)  # 500 ms: entries 1, 2, 3
	want = ["e:p1", "e:p2", "fc:3", "e:p3"]
	assert_eq(rec.take(), want)


func test_pingpong_back_edge_fires_the_frame_it_returns_to() -> void:
	driver.play(&"pp")
	driver.seek_ms(500.0)  # frame 3
	rec.take()
	driver.advance(0.25)  # 750 ms: entry 4 (frame 2) starts
	assert_eq(rec.take(), ["fc:2", "e:p2"] as Array[String])
	driver.advance(0.125)  # 875: entry 5 (frame 1)
	assert_eq(rec.take(), ["fc:1", "e:p1"] as Array[String])


func test_hold_last_fires_nothing_more() -> void:
	driver.play(&"lin")
	driver.hold_last = true
	rec.take()
	driver.advance(10.0)
	assert_eq(rec.take(), ["e:l1", "fc:2", "e:l2", "finished"] as Array[String])
	driver.advance(10.0)
	assert_eq(rec.take(), [] as Array[String], "held: no events, no repeated finished")


func test_hold_last_on_pingpong_stops_after_the_forward_pass() -> void:
	driver.play(&"pp")
	driver.hold_last = true
	rec.take()
	driver.advance(10.0)
	assert_eq(rec.take(), ["e:p1", "e:p2", "fc:3", "e:p3", "finished"] as Array[String])


func test_releasing_hold_last_resumes_events() -> void:
	driver.play(&"lin")
	driver.hold_last = true
	driver.advance(10.0)
	rec.take()
	driver.hold_last = false
	assert_eq(rec.take(), [] as Array[String], "clearing fires nothing")
	driver.advance(0.125)  # 625 ms: frame 0 of the next pass started, then frame 1
	assert_eq(rec.take(), ["e:l0", "fc:1", "e:l1"] as Array[String])


func test_a_paused_driver_fires_nothing() -> void:
	driver.play(&"lin")
	rec.take()
	driver.paused = true
	driver.advance(1.0)
	assert_eq(rec.take(), [] as Array[String])


func test_seek_fires_only_the_target_frames_events() -> void:
	driver.play(&"pp")
	rec.take()
	driver.seek_ms(750.0)  # jumps over frames 1, 2 and 3 to entry 4 (frame 2)
	assert_eq(rec.take(), ["fc:2", "e:p2"] as Array[String])


func test_seek_to_the_frame_already_shown_fires_nothing() -> void:
	driver.play(&"lin")
	driver.seek_ms(130.0)
	rec.take()
	driver.seek_ms(300.0)  # still frame 1
	driver.seek_ms(374.0)
	assert_eq(rec.take(), [] as Array[String])


func test_seek_across_wraps_still_fires_only_the_target_frame() -> void:
	driver.play(&"lin")
	rec.take()
	driver.seek_ms(1375.0)  # frame 2 of the third pass
	assert_eq(rec.take(), ["fc:2", "e:l2"] as Array[String])


func test_seek_can_suppress_events() -> void:
	driver.play(&"lin")
	rec.take()
	driver.seek_ms(400.0, false)
	assert_eq(rec.take(), ["fc:2"] as Array[String], "frame_changed still fires")


func test_set_frame_fires_only_the_target_frames_events() -> void:
	driver.play(&"lin")
	rec.take()
	driver.set_frame(2)
	assert_eq(rec.take(), ["fc:2", "e:l2"] as Array[String])
	driver.set_frame(2)
	assert_eq(rec.take(), [] as Array[String], "already shown")
	driver.set_frame(0, false)
	assert_eq(rec.take(), ["fc:0"] as Array[String])
	driver.set_frame(99)
	assert_eq(rec.take(), ["fc:2", "e:l2"] as Array[String], "clamped to the last frame")


func test_a_direction_change_fires_no_events() -> void:
	driver.play(&"dirs", &"side")
	driver.seek_ms(200.0)  # side: frame 1 (125..375)
	rec.take()
	driver.direction = &"up"  # up: frame 1 spans 125..250; the picture changes
	assert_eq(rec.take(), ["fc:1"] as Array[String], "frame_changed, no events")
	assert_eq(driver.position_ms, 200.0, "the position is kept")
	driver.direction = &"side"
	assert_eq(rec.take(), ["fc:1"] as Array[String])
	driver.seek_ms(300.0)
	rec.take()
	driver.direction = &"up"  # at 300 ms up shows frame 2 (250..500)
	assert_eq(rec.take(), ["fc:2"] as Array[String])


func test_a_direction_change_to_the_same_entry_is_silent() -> void:
	driver.play(&"dirs", &"side")
	rec.take()
	driver.direction = &"down"  # falls back to side, which is already playing
	assert_eq(rec.take(), [] as Array[String])
	assert_eq(driver.direction, &"down")


func test_skin_and_mirror_changes_fire_nothing() -> void:
	driver.play(&"lin")
	rec.take()
	driver.skin = &"alt"
	driver.mirror = true
	driver.mirror = false
	assert_eq(rec.take(), [] as Array[String])


func test_finished_fires_once_per_play_on_once() -> void:
	driver.play(&"once")
	rec.take()
	driver.advance(0.25)
	driver.advance(0.125)
	assert_eq(rec.take(), ["fc:1", "e:o1", "fc:2", "e:o2"] as Array[String], "375 ms: frame 2 started, not over")
	driver.advance(0.125)  # 500 = T
	assert_eq(rec.take(), ["finished"] as Array[String])
	driver.advance(1.0)
	assert_eq(rec.take(), [] as Array[String], "once per play")
	driver.play(&"once", &"default", true)
	rec.take()
	driver.advance(10.0)
	assert_eq(rec.take(), ["e:o1", "fc:2", "e:o2", "finished"] as Array[String], "re-armed by play")


func test_looping_animations_never_finish() -> void:
	driver.play(&"lin")
	rec.take()
	driver.advance(5.0)
	assert_false(rec.take().has("finished"))
	assert_false(driver.is_finished())


func test_a_handler_that_plays_cuts_the_interrupted_step_short() -> void:
	driver.play(&"lin")
	rec.take()
	var seen: Array[String] = []
	driver.event.connect(
		func(n: StringName) -> void:
			seen.append(String(n))
			if n == &"l1":
				driver.play(&"once")
	)
	driver.advance(1.25)  # would fire l1 l2 l0 ... ; the first l1 starts "once" instead
	assert_eq(seen, ["l1", "o0"] as Array[String], "play fired o0 at once; the rest of the step is dropped")
	assert_eq(driver.group, &"once")
	assert_eq(driver.frame, 0)
	assert_eq(driver.position_ms, 0.0)


func test_a_handler_that_seeks_takes_effect_at_once() -> void:
	driver.play(&"lin")
	rec.take()
	driver.frame_changed.connect(
		func(i: int) -> void:
			if i == 2:
				driver.seek_ms(0.0, false)
	)
	driver.advance(0.375)  # reaches frame 2; the handler seeks back to frame 0
	assert_eq(driver.frame, 0)
	assert_eq(driver.position_ms, 0.0)
	assert_false(rec.take().has("e:l2"), "frame 2's events were dropped with the rest of the step")


func test_play_of_the_playing_entry_continues_and_restart_replays() -> void:
	driver.play(&"lin")
	driver.advance(0.25)
	rec.take()
	assert_true(driver.play(&"lin"))
	assert_eq(driver.position_ms, 250.0, "same entry: no restart")
	assert_eq(rec.take(), [] as Array[String])
	assert_true(driver.play(&"lin", &"default", true))
	assert_eq(driver.position_ms, 0.0)
	assert_eq(rec.take(), ["fc:0", "e:l0"] as Array[String])


func test_play_of_a_new_resolved_entry_restarts() -> void:
	driver.play(&"dirs", &"side")
	driver.advance(0.25)
	assert_true(driver.play(&"dirs", &"up"))
	assert_eq(driver.position_ms, 0.0)
	assert_eq(driver.direction, &"up", "play sets direction")
	assert_true(driver.play(&"dirs", &"down"), "down falls back to side, a different entry from up")
	assert_eq(driver.position_ms, 0.0)
	assert_eq(driver.direction, &"down")


func test_play_with_a_fallback_to_the_same_entry_does_not_restart() -> void:
	driver.play(&"dirs", &"side")
	driver.advance(0.25)
	assert_true(driver.play(&"dirs", &"down"))
	assert_eq(driver.position_ms, 250.0)


func test_play_with_no_resolution_keeps_the_current_animation() -> void:
	driver.play(&"lin")
	driver.advance(0.25)
	assert_false(driver.play(&"missing"))
	assert_push_error("no animation")
	assert_eq(driver.group, &"lin")
	assert_eq(driver.position_ms, 250.0)
	assert_false(driver.play(&"dirs", &"nowhere"), "dirs has no default and no fallback for it")
	assert_push_error("no animation")


func test_play_without_an_asset_is_an_error() -> void:
	var d := PixelForgeDriver.new()
	add_child_autofree(d)
	assert_false(d.play(&"lin"))
	assert_push_error("no asset")
