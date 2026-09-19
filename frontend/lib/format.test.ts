import test from "node:test";
import assert from "node:assert/strict";
import { stroopsToDisplay, displayToStroops } from "./format";

test("round-trip conversion between stroops and display strings", () => {
  const cases: Array<[number, string]> = [
    [10_000_000, "1"],
    [5_000_000, "0.5"],
    [123_4567890, "123.456789"],
    [1, "0.0000001"],
    [0, "0"],
    [17_500_000, "1.75"],
    [4_100_000, "0.41"],
    [11_400_000, "1.14"],
  ];

  for (const [stroops, display] of cases) {
    // stroops -> display
    assert.equal(stroopsToDisplay(stroops), display, `stroopsToDisplay(${stroops})`);
    // display -> stroops
    assert.equal(displayToStroops(display), stroops, `displayToStroops(${display})`);
    // full round-trip
    assert.equal(displayToStroops(stroopsToDisplay(stroops)), stroops, `round-trip ${stroops}`);
  }
});

test("handles values that would lose precision with IEEE-754 floats", () => {
  // 0.41 * 10_000_000 evaluates to 4099999.9999999995 in JavaScript floating point
  const floatBad1 = 0.41 * 10_000_000;
  assert.equal(floatBad1 === 4099999.9999999995, true, "Demonstrates 0.41 float precision loss");
  assert.equal(Math.floor(floatBad1), 4099999, "Naive float parsing loses 1 stroop on 0.41");

  // displayToStroops avoids this and parses exact stroops
  const exactStroops1 = displayToStroops("0.41");
  assert.equal(exactStroops1, 4100000, "displayToStroops parses 0.41 to exactly 4,100,000 stroops");
  assert.equal(stroopsToDisplay(exactStroops1), "0.41", "stroopsToDisplay formats back to 0.41");

  // 1.14 * 10_000_000 evaluates to 11399999.999999998 in JavaScript floating point
  const floatBad2 = 1.14 * 10_000_000;
  assert.equal(floatBad2 === 11399999.999999998, true, "Demonstrates 1.14 float precision loss");
  assert.equal(Math.floor(floatBad2), 11399999, "Naive float parsing loses 1 stroop on 1.14");

  const exactStroops2 = displayToStroops("1.14");
  assert.equal(exactStroops2, 11400000, "displayToStroops parses 1.14 to exactly 11,400,000 stroops");
  assert.equal(stroopsToDisplay(exactStroops2), "1.14", "stroopsToDisplay formats back to 1.14");
});
