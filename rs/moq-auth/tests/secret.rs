use moq_auth::serve::{Keys, Policy, Refusal};
use moq_auth::{Claims, Key, Patterns, Permissions, Request, Transport};

fn patterns(texts: &[&str]) -> Patterns {
	texts.iter().map(|text| text.parse().unwrap()).collect()
}

fn request(path: &str, jwt: Option<&str>) -> Request {
	let mut request = Request::new("relay-1", Transport::Quic, path);
	request.query = jwt.map(|jwt| format!("jwt={jwt}"));
	request
}

fn policy(secret: &str) -> Policy {
	let mut policy = Policy::default();
	policy.keys = Some(Keys::Secret(Box::new(Key::from_secret(secret.as_bytes()))));
	policy.public = Permissions::new(patterns(&["anon/**"]), patterns(&["anon/**"]));
	policy
}

fn token(secret: &str) -> String {
	let claims = Claims::default()
		.with_root("alluno")
		.with_publish(patterns(&["hosts/**"]))
		.with_subscribe(patterns(&["**"]));
	Key::from_secret(secret.as_bytes()).sign(&claims).unwrap()
}

#[tokio::test]
async fn a_token_signed_with_a_short_shared_secret_is_admitted() {
	let grant = policy("db-password")
		.decide(&request("/alluno", Some(&token("db-password"))))
		.await
		.unwrap();

	assert_eq!(grant.publish, patterns(&["hosts/**"]));
	assert_eq!(grant.subscribe, patterns(&["**"]));
}

#[tokio::test]
async fn a_token_signed_with_another_secret_is_refused() {
	let refusal = policy("db-password")
		.decide(&request("/alluno", Some(&token("someone-else"))))
		.await
		.unwrap_err();

	assert!(matches!(refusal, Refusal::InvalidToken(_)), "{refusal:?}");
}

#[tokio::test]
async fn a_session_without_a_token_gets_the_public_patterns() {
	let grant = policy("db-password").decide(&request("/", None)).await.unwrap();

	assert_eq!(grant.publish, patterns(&["anon/**"]));
	assert_eq!(grant.subscribe, patterns(&["anon/**"]));
}
