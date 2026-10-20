// One oversized triangle covers the viewport, so there is no vertex buffer and no diagonal seam.
// The vertex stage maps each canvas coordinate to the frame coordinate it shows, which handles
// rotation and flip; the interpolation is exact because the map is affine. Needs `params.x` and
// `params.y` rows in the shader that includes it.
export const VERTEX = /* wgsl */ `
struct Vertex {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
	let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
	let p = vec3<f32>(uv, 1.0);
	var out: Vertex;
	out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
	out.uv = vec2<f32>(dot(params.x.xyz, p), dot(params.y.xyz, p));
	return out;
}
`;

// `present` turns a sampled colour into the canvas colour: as sampled, or decoded from a PQ signal
// and either extended or rolled off, per `tone.x`, with `tone.y` the reference white.
export const TONE = /* wgsl */ `
const BT709_TO_BT2020 = mat3x3<f32>(
	vec3<f32>(0.627402, 0.069095, 0.016394),
	vec3<f32>(0.329292, 0.919544, 0.088028),
	vec3<f32>(0.043306, 0.011360, 0.895578));
const BT2020_TO_BT709 = mat3x3<f32>(
	vec3<f32>(1.660491, -0.124550, -0.018151),
	vec3<f32>(-0.587641, 1.132900, -0.100579),
	vec3<f32>(-0.072850, -0.008349, 1.118730));

fn srgb_decode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a / 12.92;
	let hi = pow((a + 0.055) / 1.055, vec3<f32>(2.4));
	return sign(c) * select(hi, lo, a <= vec3<f32>(0.04045));
}

fn srgb_encode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a * 12.92;
	let hi = 1.055 * pow(a, vec3<f32>(1.0 / 2.4)) - 0.055;
	return sign(c) * select(hi, lo, a <= vec3<f32>(0.0031308));
}

fn pq_eotf(e: vec3<f32>) -> vec3<f32> {
	let m1 = 0.1593017578125;
	let m2 = 78.84375;
	let c1 = 0.8359375;
	let c2 = 18.8515625;
	let c3 = 18.6875;
	let ep = pow(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / m2));
	let num = max(ep - c1, vec3<f32>(0.0));
	let den = c2 - c3 * ep;
	return pow(num / den, vec3<f32>(1.0 / m1)) * 10000.0;
}

fn roll_off(c: vec3<f32>) -> vec3<f32> {
	let y = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
	let knee = 0.8;
	if (y <= knee) {
		return c;
	}
	let t = (y - knee) / (1.0 - knee);
	let yn = knee + (1.0 - knee) * (1.0 - exp(-t));
	return c * (yn / y);
}

fn present(rgb: vec3<f32>, tone: vec4<f32>) -> vec4<f32> {
	if (tone.x < 0.5) {
		return vec4<f32>(rgb, 1.0);
	}
	var light = BT2020_TO_BT709 * (pq_eotf(BT709_TO_BT2020 * srgb_decode(rgb)) / tone.y);
	if (tone.x > 1.5) {
		light = clamp(roll_off(max(light, vec3<f32>(0.0))), vec3<f32>(0.0), vec3<f32>(1.0));
	}
	return vec4<f32>(srgb_encode(light), 1.0);
}
`;
