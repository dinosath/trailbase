use super::*;
use axum::extract::State;
use serde_json::{Map, Value, json};

fn slug(value: &str) -> String {
  let mut result = String::new();
  let mut separator = false;
  for ch in value.trim().chars() {
    if ch.is_ascii_alphanumeric() {
      if separator && !result.is_empty() {
        result.push('_');
      }
      result.push(ch.to_ascii_lowercase());
      separator = false;
    } else {
      separator = true;
    }
  }
  result
}

fn normalize_uid(uid: &str) -> String {
  uid
    .split("::")
    .map(|part| part.split('.').map(slug).collect::<Vec<_>>().join("."))
    .collect::<Vec<_>>()
    .join("::")
}

fn normalize_attribute(value: &Value, uid_map: &BTreeMap<String, String>) -> Value {
  let Some(source) = value.as_object() else {
    return json!({ "type": value.as_str().unwrap_or("string") });
  };
  let mut output = Map::new();
  for (key, value) in source {
    if matches!(
      key.as_str(),
      "enum" | "fieldType" | "target" | "relation" | "mappedBy" | "inversedBy"
    ) {
      continue;
    }
    if key == "attributes" {
      if let Some(attributes) = value.as_object() {
        output.insert(
          key.clone(),
          Value::Object(
            attributes
              .iter()
              .map(|(name, attribute)| (slug(name), normalize_attribute(attribute, uid_map)))
              .collect(),
          ),
        );
      }
      continue;
    }
    if key == "relationTarget" {
      if let Some(target) = value.as_str() {
        output.insert(
          key.clone(),
          Value::String(
            uid_map
              .get(target)
              .cloned()
              .unwrap_or_else(|| normalize_uid(target)),
          ),
        );
      }
      continue;
    }
    if key == "type" && value.as_str() == Some("enum") {
      output.insert(key.clone(), Value::String("enumeration".to_string()));
      continue;
    }
    if key == "relationCardinality" {
      let cardinality = value
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace(['-', '_', ' '], "");
      let normalized = if cardinality == "manytomany" {
        Some("manyToMany")
      } else if matches!(cardinality.as_str(), "manytoone" | "onetomany" | "onetoone") {
        Some("manyToOne")
      } else {
        None
      };
      if let Some(normalized) = normalized {
        output.insert(key.clone(), Value::String(normalized.to_string()));
      }
      continue;
    }
    output.insert(key.clone(), value.clone());
  }
  if !output.contains_key("enumValues")
    && let Some(values) = source.get("enum")
  {
    output.insert("enumValues".to_string(), values.clone());
  }
  if !output.contains_key("relationTarget")
    && let Some(target) = source.get("target").and_then(Value::as_str)
  {
    output.insert(
      "relationTarget".to_string(),
      Value::String(
        uid_map
          .get(target)
          .cloned()
          .unwrap_or_else(|| normalize_uid(target)),
      ),
    );
  }
  if !output.contains_key("relationCardinality")
    && let Some(relation) = source.get("relation").and_then(Value::as_str)
  {
    let cardinality = relation.to_ascii_lowercase().replace(['-', '_', ' '], "");
    let normalized = if cardinality == "manytomany" {
      Some("manyToMany")
    } else if matches!(cardinality.as_str(), "manytoone" | "onetomany" | "onetoone") {
      Some("manyToOne")
    } else {
      None
    };
    if let Some(normalized) = normalized {
      output.insert(
        "relationCardinality".to_string(),
        Value::String(normalized.to_string()),
      );
    }
  }
  Value::Object(output)
}

fn normalize_definitions(value: Value) -> Result<Vec<Value>, Error> {
  let definitions = value
    .as_array()
    .or_else(|| value.get("contentTypes").and_then(Value::as_array))
    .ok_or_else(|| {
      Error::Precondition("Expected a content type array or { contentTypes: [...] }".into())
    })?;
  let mut uid_map = BTreeMap::new();
  for definition in definitions {
    let info = definition
      .get("info")
      .and_then(Value::as_object)
      .ok_or_else(|| Error::Precondition("Each content type must include info".into()))?;
    let singular = info
      .get("singularName")
      .or_else(|| info.get("singular_name"))
      .and_then(Value::as_str)
      .ok_or_else(|| Error::Precondition("Content type info requires singularName".into()))?;
    let plural = info
      .get("pluralName")
      .or_else(|| info.get("plural_name"))
      .and_then(Value::as_str)
      .ok_or_else(|| Error::Precondition("Content type info requires pluralName".into()))?;
    let uid = definition
      .get("uid")
      .and_then(Value::as_str)
      .map(normalize_uid)
      .unwrap_or_else(|| format!("api::{}.{}", slug(singular), slug(singular)));
    uid_map.insert(format!("api::{singular}.{singular}"), uid.clone());
    uid_map.insert(format!("api::{plural}.{plural}"), uid.clone());
    uid_map.insert(uid.clone(), uid);
  }

  definitions
    .iter()
    .map(|definition| {
      let info = definition.get("info").and_then(Value::as_object).unwrap();
      let singular = info.get("singularName").or_else(|| info.get("singular_name")).and_then(Value::as_str).unwrap();
      let plural = info.get("pluralName").or_else(|| info.get("plural_name")).and_then(Value::as_str).unwrap();
      let display_name = info.get("displayName").or_else(|| info.get("display_name")).cloned().unwrap_or_else(|| json!(singular));
      let uid = definition
        .get("uid")
        .and_then(Value::as_str)
        .map(normalize_uid)
        .unwrap_or_else(|| format!("api::{}.{}", slug(singular), slug(singular)));
      let attributes = definition
        .get("attributes")
        .and_then(Value::as_object)
        .ok_or_else(|| Error::Precondition(format!("Content type {singular} requires an attributes object")))?;
      let attributes = attributes
        .iter()
        .map(|(name, value)| (slug(name), normalize_attribute(value, &uid_map)))
        .collect::<Map<_, _>>();
      let description = info.get("description").cloned();
      Ok(json!({
        "uid": uid,
        "kind": if definition.get("kind").and_then(Value::as_str) == Some("singleType") { "singleType" } else { "collectionType" },
        "info": {
          "singularName": slug(singular),
          "pluralName": slug(plural),
          "displayName": display_name,
          "description": description
        },
        "attributes": attributes
      }))
    })
    .collect()
}

fn has_sql_default(attribute: &Value) -> bool {
  attribute["default"]["type"] == "sqlView"
    || attribute["attributes"]
      .as_object()
      .is_some_and(|children| children.values().any(has_sql_default))
}

fn without_sql_defaults(attribute: &Value) -> Value {
  let mut result = attribute.clone();
  if result["default"]["type"] == "sqlView" {
    result.as_object_mut().unwrap().remove("default");
  }
  if let Some(children) = result.get_mut("attributes").and_then(Value::as_object_mut) {
    for child in children.values_mut() {
      *child = without_sql_defaults(child);
    }
  }
  result
}

fn without_sql_defaults_definition(definition: &Value) -> Value {
  let mut result = definition.clone();
  if let Some(attributes) = result.get_mut("attributes").and_then(Value::as_object_mut) {
    for attribute in attributes.values_mut() {
      *attribute = without_sql_defaults(attribute);
    }
  }
  result
}

#[utoipa::path(
  post,
  path = "/content-types/import",
  tag = "content-types",
  request_body(content = serde_json::Value, description = "A content type bundle in JSON format"),
  responses((status = 200, description = "Imported content types", body = ContentTypesResponse))
)]
pub(crate) async fn import_content_types(
  State(state): State<AppState>,
  Json(value): Json<Value>,
) -> Result<Json<ContentTypesResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  let definitions = normalize_definitions(value)?;
  if definitions.is_empty() {
    return Err(Error::Precondition(
      "The import bundle contains no content types".into(),
    ));
  }

  let mut deferred = Vec::new();
  let mut sql_defaults = Vec::new();
  for definition in &definitions {
    let mut initial = definition.clone();
    let attributes = definition["attributes"].as_object().unwrap();
    let mut initial_attributes = Map::new();
    let mut has_deferred = false;
    for (name, attribute) in attributes {
      let defer = attribute["type"] == "relation"
        || attribute["computed"] == true
        || has_sql_default(attribute);
      if defer {
        has_deferred = true;
      } else {
        initial_attributes.insert(name.clone(), attribute.clone());
      }
    }
    *initial.get_mut("attributes").unwrap() = Value::Object(initial_attributes);
    let request: CreateContentTypeRequest = serde_json::from_value(initial)?;
    let _ = create_content_type(State(state.clone()), Json(request)).await?;
    if has_deferred {
      deferred.push(without_sql_defaults_definition(definition));
    }
    if attributes.values().any(has_sql_default) {
      sql_defaults.push(definition.clone());
    }
  }

  for definition in deferred.into_iter().chain(sql_defaults) {
    let uid = definition["uid"].as_str().unwrap().to_string();
    let request: CreateContentTypeRequest = serde_json::from_value(definition)?;
    let _ = update_content_type(
      State(state.clone()),
      Path(uid),
      Json(UpdateContentTypeRequest {
        schema: request,
        renamed_attributes: BTreeMap::new(),
      }),
    )
    .await?;
  }

  Ok(Json(ContentTypesResponse {
    data: load_all(&connection(&state).await?).await?,
  }))
}
