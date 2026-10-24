//! Lightweight Ferris-style content type definitions for the admin API.
//!
//! Content types are backed by regular TrailBase tables. Creating a definition
//! provisions its table and registers a record API, so content remains usable
//! through TrailBase's normal `/api/{pluralName}` endpoints.

pub(super) mod import;

use axum::{
  Json,
  extract::{Path, State},
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use trailbase_sqlite::ConnectionType;
use utoipa::ToSchema;

use crate::{
  admin::AdminError as Error,
  app_state::AppState,
  config::proto::{self, PermissionFlag},
  transaction_recorder::TransactionRecorder,
};

const REGISTRY_TABLE: &str = "_content_type_schemas";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeInfo {
  pub singular_name: String,
  pub plural_name: String,
  pub display_name: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub description: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeAttribute {
  #[serde(rename = "type")]
  pub field_type: String,
  #[serde(default)]
  pub required: bool,
  #[serde(default)]
  pub unique: bool,
  #[serde(default)]
  pub private: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub default: Option<serde_json::Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub min: Option<serde_json::Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max: Option<serde_json::Value>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub min_length: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub max_length: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub regex: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub target_field: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub multiple: Option<bool>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub allowed_types: Vec<String>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub enum_values: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub relation_target: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub relation_cardinality: Option<String>,
  #[serde(
    default,
    rename = "attributes",
    skip_serializing_if = "Option::is_none"
  )]
  #[schema(ignore)]
  pub relation_attributes: Option<BTreeMap<String, ContentTypeAttribute>>,
  #[serde(default)]
  pub computed: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expression: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stored: Option<bool>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub dependencies: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub rollup: Option<ContentTypeRollup>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeRollup {
  pub relation: String,
  pub field: String,
  #[serde(default = "default_rollup_aggregate")]
  pub aggregate: String,
  #[serde(default = "default_rollup_stored")]
  pub stored: bool,
}

fn default_rollup_aggregate() -> String {
  "sum".to_string()
}

fn default_rollup_stored() -> bool {
  true
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeSchema {
  pub uid: String,
  pub kind: String,
  pub info: ContentTypeInfo,
  #[serde(default)]
  pub attributes: BTreeMap<String, ContentTypeAttribute>,
  #[serde(default)]
  pub table_name: Option<String>,
  #[serde(default)]
  pub views: ContentTypeViews,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeView {
  pub id: String,
  pub name: String,
  #[serde(rename = "type")]
  pub view_type: String,
  #[serde(default)]
  pub filter: String,
  #[serde(default)]
  pub sort: Vec<serde_json::Value>,
  #[serde(default)]
  pub columns: Vec<serde_json::Value>,
  #[serde(default)]
  pub is_default: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContentTypeViews {
  #[serde(default = "default_views_version")]
  pub version: u32,
  #[serde(default = "default_views")]
  pub views: Vec<ContentTypeView>,
  #[serde(default = "default_selected_view")]
  pub selected_view_id: String,
}

impl Default for ContentTypeViews {
  fn default() -> Self {
    Self {
      version: 1,
      views: default_views(),
      selected_view_id: default_selected_view(),
    }
  }
}

fn default_views_version() -> u32 {
  1
}

fn default_selected_view() -> String {
  "table".to_string()
}

fn default_views() -> Vec<ContentTypeView> {
  vec![
    ContentTypeView {
      id: "table".to_string(),
      name: "Table".to_string(),
      view_type: "table".to_string(),
      filter: String::new(),
      sort: Vec::new(),
      columns: Vec::new(),
      is_default: true,
    },
    ContentTypeView {
      id: "form".to_string(),
      name: "Form".to_string(),
      view_type: "form".to_string(),
      filter: String::new(),
      sort: Vec::new(),
      columns: Vec::new(),
      is_default: true,
    },
  ]
}

fn normalize_default_views(views: ContentTypeViews) -> ContentTypeViews {
  let mut defaults = default_views();
  let mut custom_views: Vec<ContentTypeView> = views
    .views
    .into_iter()
    .filter(|view| view.id != "table" && view.id != "form" && !view.is_default)
    .collect();
  defaults.append(&mut custom_views);
  let selected_view_id = if defaults
    .iter()
    .any(|view| view.id == views.selected_view_id)
  {
    views.selected_view_id
  } else {
    default_selected_view()
  };
  ContentTypeViews {
    version: 1,
    views: defaults,
    selected_view_id,
  }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateContentTypeRequest {
  pub uid: String,
  pub kind: String,
  pub info: ContentTypeInfo,
  #[serde(default)]
  pub attributes: BTreeMap<String, ContentTypeAttribute>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateContentTypeRequest {
  #[serde(flatten)]
  pub schema: CreateContentTypeRequest,
  #[serde(default)]
  pub renamed_attributes: BTreeMap<String, String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentTypesResponse {
  pub data: Vec<ContentTypeSchema>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ContentTypeResponse {
  pub data: ContentTypeSchema,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DeleteContentTypeResponse {
  pub uid: String,
  pub table_name: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteContentTypesRequest {
  pub uids: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DeleteContentTypesResponse {
  pub uids: Vec<String>,
}

fn quote_identifier(name: &str) -> String {
  format!("\"{}\"", name.replace('"', "\"\""))
}

fn validate_slug(value: &str, label: &str) -> Result<(), Error> {
  if value.is_empty()
    || value.len() > 63
    || !value
      .bytes()
      .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    || value.as_bytes()[0].is_ascii_digit()
  {
    return Err(Error::Precondition(format!(
      "{label} must start with a lowercase letter and contain only lowercase letters, digits, and underscores"
    )));
  }
  Ok(())
}

fn validate_uid(value: &str) -> Result<(), Error> {
  let normalized = value.replace("::", ".");
  if normalized.is_empty()
    || normalized
      .split('.')
      .any(|part| validate_slug(part, "uid segment").is_err())
  {
    return Err(Error::Precondition(
      "uid must contain lowercase identifier segments separated by `.` or `::`".into(),
    ));
  }
  Ok(())
}

fn field_sql_type(field_type: &str) -> Result<&'static str, Error> {
  match field_type {
    "string" | "text" | "richtext" | "richtext_markdown" | "blocks" | "email" | "password"
    | "uid" | "date" | "datetime" | "time" | "json" | "media" | "enumeration" => Ok("TEXT"),
    "integer" | "biginteger" | "boolean" | "relation" => Ok("INTEGER"),
    "decimal" | "float" => Ok("REAL"),
    _ => Err(Error::Precondition(format!(
      "Unsupported content type field type `{field_type}`"
    ))),
  }
}

fn sql_literal(value: &serde_json::Value) -> Result<String, Error> {
  match value {
    serde_json::Value::Null => Ok("NULL".into()),
    serde_json::Value::Bool(value) => Ok(if *value { "1" } else { "0" }.into()),
    serde_json::Value::Number(value) => Ok(value.to_string()),
    serde_json::Value::String(value) => Ok(format!("'{}'", value.replace('\'', "''"))),
    serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
      let json = serde_json::to_string(value)?;
      Ok(format!("'{}'", json.replace('\'', "''")))
    }
  }
}

fn supports_generated(field_type: &str) -> bool {
  matches!(
    field_type,
    "integer"
      | "biginteger"
      | "decimal"
      | "float"
      | "string"
      | "text"
      | "boolean"
      | "date"
      | "datetime"
  )
}

#[derive(Clone, Debug, PartialEq)]
enum GeneratedToken {
  Ident(String),
  Literal,
  Operator(&'static str),
  Open,
  Close,
  Comma,
}

fn tokenize_generated_expression(source: &str) -> Result<Vec<GeneratedToken>, String> {
  let bytes = source.as_bytes();
  let mut pos = 0;
  let mut tokens = Vec::new();
  while pos < bytes.len() {
    let byte = bytes[pos];
    if byte.is_ascii_whitespace() {
      pos += 1;
      continue;
    }
    if byte.is_ascii_alphabetic() || byte == b'_' {
      let start = pos;
      pos += 1;
      while pos < bytes.len() && (bytes[pos].is_ascii_alphanumeric() || bytes[pos] == b'_') {
        pos += 1;
      }
      tokens.push(GeneratedToken::Ident(source[start..pos].to_string()));
      continue;
    }
    if byte.is_ascii_digit() {
      pos += 1;
      while pos < bytes.len() && (bytes[pos].is_ascii_digit() || bytes[pos] == b'.') {
        pos += 1;
      }
      tokens.push(GeneratedToken::Literal);
      continue;
    }
    if byte == b'\'' {
      pos += 1;
      loop {
        if pos >= bytes.len() {
          return Err("unterminated string literal".into());
        }
        if bytes[pos] == b'\'' {
          if pos + 1 < bytes.len() && bytes[pos + 1] == b'\'' {
            pos += 2;
          } else {
            pos += 1;
            break;
          }
        } else {
          pos += 1;
        }
      }
      tokens.push(GeneratedToken::Literal);
      continue;
    }
    if byte == b'(' {
      tokens.push(GeneratedToken::Open);
      pos += 1;
      continue;
    }
    if byte == b')' {
      tokens.push(GeneratedToken::Close);
      pos += 1;
      continue;
    }
    if byte == b',' {
      tokens.push(GeneratedToken::Comma);
      pos += 1;
      continue;
    }
    let tail = &source[pos..];
    let operator = ["||", "<>", "!=", "<=", ">="]
      .into_iter()
      .find(|op| tail.starts_with(op));
    if let Some(op) = operator {
      tokens.push(GeneratedToken::Operator(match op {
        "||" => "||",
        "<>" => "<>",
        "!=" => "!=",
        "<=" => "<=",
        ">=" => ">=",
        _ => unreachable!(),
      }));
      pos += op.len();
      continue;
    }
    let op = match byte {
      b'+' => "+",
      b'-' => "-",
      b'*' => "*",
      b'/' => "/",
      b'%' => "%",
      b'=' => "=",
      b'<' => "<",
      b'>' => ">",
      _ => return Err(format!("unsupported character `{}`", byte as char)),
    };
    tokens.push(GeneratedToken::Operator(op));
    pos += 1;
  }
  Ok(tokens)
}

struct GeneratedExpressionParser {
  tokens: Vec<GeneratedToken>,
  pos: usize,
  dependencies: BTreeSet<String>,
}

impl GeneratedExpressionParser {
  fn peek(&self) -> Option<&GeneratedToken> {
    self.tokens.get(self.pos)
  }

  fn eat_operator(&mut self, allowed: &[&str]) -> Option<&'static str> {
    match self.peek() {
      Some(GeneratedToken::Operator(op)) if allowed.contains(op) => {
        let result = *op;
        self.pos += 1;
        Some(result)
      }
      _ => None,
    }
  }

  fn parse_expression(&mut self) -> Result<(), String> {
    self.parse_additive()?;
    while self
      .eat_operator(&["=", "!=", "<>", "<", "<=", ">", ">="])
      .is_some()
    {
      self.parse_additive()?;
    }
    Ok(())
  }

  fn parse_additive(&mut self) -> Result<(), String> {
    self.parse_multiplicative()?;
    while self.eat_operator(&["+", "-", "||"]).is_some() {
      self.parse_multiplicative()?;
    }
    Ok(())
  }

  fn parse_multiplicative(&mut self) -> Result<(), String> {
    self.parse_unary()?;
    while self.eat_operator(&["*", "/", "%"]).is_some() {
      self.parse_unary()?;
    }
    Ok(())
  }

  fn parse_unary(&mut self) -> Result<(), String> {
    if self.eat_operator(&["-"]).is_some() {
      return self.parse_unary();
    }
    self.parse_primary()
  }

  fn parse_primary(&mut self) -> Result<(), String> {
    match self.tokens.get(self.pos).cloned() {
      Some(GeneratedToken::Literal) => {
        self.pos += 1;
        Ok(())
      }
      Some(GeneratedToken::Open) => {
        self.pos += 1;
        self.parse_expression()?;
        if self.tokens.get(self.pos) != Some(&GeneratedToken::Close) {
          return Err("expected closing parenthesis".into());
        }
        self.pos += 1;
        Ok(())
      }
      Some(GeneratedToken::Ident(name)) => {
        self.pos += 1;
        let lower = name.to_ascii_lowercase();
        if matches!(lower.as_str(), "true" | "false" | "null") {
          return Ok(());
        }
        if self.tokens.get(self.pos) == Some(&GeneratedToken::Open) {
          if !matches!(
            lower.as_str(),
            "coalesce" | "round" | "abs" | "lower" | "upper" | "length"
          ) {
            return Err(format!("function `{name}` is not allowed"));
          }
          self.pos += 1;
          let mut argc = 0;
          if self.tokens.get(self.pos) != Some(&GeneratedToken::Close) {
            loop {
              self.parse_expression()?;
              argc += 1;
              if self.tokens.get(self.pos) == Some(&GeneratedToken::Comma) {
                self.pos += 1;
              } else {
                break;
              }
            }
          }
          if self.tokens.get(self.pos) != Some(&GeneratedToken::Close) {
            return Err("expected closing parenthesis after function arguments".into());
          }
          self.pos += 1;
          let valid_arity = match lower.as_str() {
            "coalesce" => argc >= 2,
            "round" => (1..=2).contains(&argc),
            _ => argc == 1,
          };
          if !valid_arity {
            return Err(format!("invalid number of arguments for `{name}`"));
          }
          Ok(())
        } else {
          self.dependencies.insert(name);
          Ok(())
        }
      }
      _ => Err("expected a field, literal, or parenthesized expression".into()),
    }
  }
}

fn parse_generated_expression(source: &str) -> Result<BTreeSet<String>, String> {
  let mut parser = GeneratedExpressionParser {
    tokens: tokenize_generated_expression(source)?,
    pos: 0,
    dependencies: BTreeSet::new(),
  };
  parser.parse_expression()?;
  if parser.pos != parser.tokens.len() {
    return Err("unexpected trailing input".into());
  }
  Ok(parser.dependencies)
}

fn has_generated_cycle(
  name: &str,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
  visiting: &mut BTreeSet<String>,
  visited: &mut BTreeSet<String>,
) -> bool {
  if visited.contains(name) {
    return false;
  }
  if !visiting.insert(name.to_string()) {
    return true;
  }
  let dependencies = attributes
    .get(name)
    .and_then(|attribute| attribute.expression.as_deref())
    .and_then(|expression| parse_generated_expression(expression).ok())
    .unwrap_or_default();
  for dependency in dependencies {
    if attributes
      .get(&dependency)
      .is_some_and(|attribute| attribute.computed)
      && has_generated_cycle(&dependency, attributes, visiting, visited)
    {
      return true;
    }
  }
  visiting.remove(name);
  visited.insert(name.to_string());
  false
}

fn normalize_attributes(
  attributes: BTreeMap<String, ContentTypeAttribute>,
) -> Result<BTreeMap<String, ContentTypeAttribute>, Error> {
  attributes
    .into_iter()
    .map(|(name, mut attribute)| {
      if let Some(relation_attributes) = attribute.relation_attributes.take() {
        attribute.relation_attributes = Some(normalize_attributes(relation_attributes)?);
      }
      if attribute.computed {
        if attribute.rollup.is_some() {
          attribute.dependencies.clear();
        } else {
          let expression = attribute.expression.as_deref().unwrap_or_default();
          attribute.dependencies = parse_generated_expression(expression)
            .map_err(|err| {
              Error::Precondition(format!("Invalid generated expression for `{name}`: {err}"))
            })?
            .into_iter()
            .collect();
        }
      } else {
        attribute.expression = None;
        attribute.stored = None;
        attribute.dependencies.clear();
        attribute.rollup = None;
      }
      Ok((name, attribute))
    })
    .collect()
}

fn sql_view_default(attribute: &ContentTypeAttribute) -> Option<&str> {
  let default = attribute.default.as_ref()?.as_object()?;
  if default.get("type")?.as_str()? != "sqlView" {
    return None;
  }
  default.get("sql")?.as_str()
}

fn is_sql_view_default(attribute: &ContentTypeAttribute) -> bool {
  sql_view_default(attribute).is_some()
}

fn validate_sql_view_default(name: &str, attribute: &ContentTypeAttribute) -> Result<(), Error> {
  let Some(default) = attribute
    .default
    .as_ref()
    .and_then(serde_json::Value::as_object)
  else {
    return Ok(());
  };
  if default.get("type").and_then(serde_json::Value::as_str) != Some("sqlView") {
    return Err(Error::Precondition(format!(
      "Structured default for `{name}` must use type `sqlView`"
    )));
  }
  let sql = default
    .get("sql")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|sql| !sql.is_empty())
    .ok_or_else(|| Error::Precondition(format!("SQL view default for `{name}` requires SQL")))?;
  let starts_with_query = ["SELECT", "WITH"].into_iter().any(|keyword| {
    sql
      .get(..keyword.len())
      .is_some_and(|prefix| prefix.eq_ignore_ascii_case(keyword))
      && sql
        .as_bytes()
        .get(keyword.len())
        .is_some_and(u8::is_ascii_whitespace)
  });
  if !starts_with_query || sql.contains(';') || sql.contains('\0') {
    return Err(Error::Precondition(format!(
      "SQL view default for `{name}` must be a single SELECT or WITH query"
    )));
  }
  if default
    .keys()
    .any(|key| !matches!(key.as_str(), "type" | "sql"))
  {
    return Err(Error::Precondition(format!(
      "SQL view default for `{name}` supports only `type` and `sql`"
    )));
  }
  Ok(())
}

fn validate_content_type(request: &CreateContentTypeRequest) -> Result<(), Error> {
  validate_uid(&request.uid)?;
  validate_slug(&request.info.singular_name, "singularName")?;
  validate_slug(&request.info.plural_name, "pluralName")?;
  if request.kind != "collectionType" && request.kind != "singleType" {
    return Err(Error::Precondition(
      "kind must be `collectionType` or `singleType`".into(),
    ));
  }
  for (name, attribute) in &request.attributes {
    validate_slug(name, "field name")?;
    if matches!(name.as_str(), "id" | "created_at" | "updated_at") {
      return Err(Error::Precondition(format!(
        "`{name}` is reserved for content type metadata"
      )));
    }
    field_sql_type(&attribute.field_type)?;
    if attribute.min_length.is_some_and(|value| value < 0)
      || attribute.max_length.is_some_and(|value| value < 0)
      || attribute
        .min_length
        .zip(attribute.max_length)
        .is_some_and(|(min, max)| min > max)
    {
      return Err(Error::Precondition(format!(
        "Invalid length range for field `{name}`"
      )));
    }
    if let Some(pattern) = &attribute.regex {
      regex::Regex::new(pattern)
        .map_err(|err| Error::Precondition(format!("Invalid regex for field `{name}`: {err}")))?;
      if !matches!(
        attribute.field_type.as_str(),
        "string" | "text" | "richtext" | "richtext_markdown" | "email" | "password" | "uid"
      ) {
        return Err(Error::Precondition(format!(
          "Regex validation is not supported for field `{name}`"
        )));
      }
    }
    if attribute.min.is_some() || attribute.max.is_some() {
      if !matches!(
        attribute.field_type.as_str(),
        "integer" | "biginteger" | "decimal" | "float"
      ) || [attribute.min.as_ref(), attribute.max.as_ref()]
        .into_iter()
        .flatten()
        .any(|value| !value.is_number())
      {
        return Err(Error::Precondition(format!(
          "Numeric field `{name}` requires numeric min/max values"
        )));
      }
      if attribute
        .min
        .as_ref()
        .and_then(serde_json::Value::as_f64)
        .zip(attribute.max.as_ref().and_then(serde_json::Value::as_f64))
        .is_some_and(|(min, max)| min > max)
      {
        return Err(Error::Precondition(format!(
          "Minimum value must not exceed maximum value for `{name}`"
        )));
      }
    }
    if let Some(default) = &attribute.default {
      if default
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(serde_json::Value::as_str)
        == Some("sqlView")
      {
        validate_sql_view_default(name, attribute)?;
      } else {
        let valid = match attribute.field_type.as_str() {
          "integer" | "biginteger" | "decimal" | "float" => default.is_number(),
          "boolean" => default.is_boolean() || default.is_null(),
          "json" | "media" => true,
          _ => default.is_string() || default.is_number() || default.is_null(),
        };
        if !valid {
          return Err(Error::Precondition(format!(
            "Default value has an incompatible type for `{name}`"
          )));
        }
      }
    }
    if (attribute.min_length.is_some() || attribute.max_length.is_some())
      && !matches!(
        attribute.field_type.as_str(),
        "string" | "text" | "richtext" | "richtext_markdown" | "email" | "password" | "uid"
      )
    {
      return Err(Error::Precondition(format!(
        "Length limits are not supported for field `{name}`"
      )));
    }
    if attribute.target_field.is_some() && attribute.field_type != "uid" {
      return Err(Error::Precondition(format!(
        "Only UID fields can specify a target field (`{name}`)"
      )));
    }
    if let Some(target_field) = &attribute.target_field {
      if !request.attributes.contains_key(target_field) {
        return Err(Error::Precondition(format!(
          "UID field `{name}` references unknown target `{target_field}`"
        )));
      }
    }
    if (attribute.multiple.is_some() || !attribute.allowed_types.is_empty())
      && attribute.field_type != "media"
    {
      return Err(Error::Precondition(format!(
        "Only media fields can specify media options (`{name}`)"
      )));
    }
    if attribute
      .allowed_types
      .iter()
      .any(|value| !matches!(value.as_str(), "images" | "videos" | "audios" | "files"))
    {
      return Err(Error::Precondition(format!(
        "Media field `{name}` has an unsupported allowed type"
      )));
    }
    if !attribute.computed
      && (attribute.expression.is_some()
        || attribute.stored.is_some()
        || !attribute.dependencies.is_empty()
        || attribute.rollup.is_some())
    {
      return Err(Error::Precondition(format!(
        "Generated-column settings on `{name}` require computed=true"
      )));
    }
    if attribute.computed {
      if !supports_generated(&attribute.field_type) {
        return Err(Error::Precondition(format!(
          "Field type `{}` cannot be generated",
          attribute.field_type
        )));
      }
      if attribute.required || attribute.unique {
        return Err(Error::Precondition(format!(
          "Generated field `{name}` cannot be required or unique"
        )));
      }
      if attribute.default.is_some() {
        return Err(Error::Precondition(format!(
          "Generated field `{name}` cannot have a default value"
        )));
      }
      if let Some(rollup) = &attribute.rollup {
        if attribute.expression.is_some()
          || !rollup.stored
          || rollup.aggregate != "sum"
          || !matches!(
            attribute.field_type.as_str(),
            "integer" | "biginteger" | "decimal" | "float"
          )
        {
          return Err(Error::Precondition(format!(
            "Stored rollup `{name}` must be a numeric SUM and cannot also have an expression"
          )));
        }
        let Some(relation) = request.attributes.get(&rollup.relation) else {
          return Err(Error::Precondition(format!(
            "Rollup `{name}` references unknown relation `{}`",
            rollup.relation
          )));
        };
        if !is_many_to_many(relation) {
          return Err(Error::Precondition(format!(
            "Rollup `{name}` must reference a many-to-many relation"
          )));
        }
        let relation_field = relation
          .relation_attributes
          .as_ref()
          .and_then(|attributes| attributes.get(&rollup.field))
          .ok_or_else(|| {
            Error::Precondition(format!(
              "Rollup `{name}` references unknown relation field `{}.{}`",
              rollup.relation, rollup.field
            ))
          })?;
        if !matches!(
          relation_field.field_type.as_str(),
          "integer" | "biginteger" | "decimal" | "float"
        ) {
          return Err(Error::Precondition(format!(
            "Rollup `{name}` must sum a numeric relation field"
          )));
        }
        continue;
      }
      let expression = attribute
        .expression
        .as_deref()
        .map(str::trim)
        .filter(|expression| !expression.is_empty())
        .ok_or_else(|| {
          Error::Precondition(format!("Generated field `{name}` requires an expression"))
        })?;
      let dependencies = parse_generated_expression(expression).map_err(|err| {
        Error::Precondition(format!("Invalid generated expression for `{name}`: {err}"))
      })?;
      for dependency in dependencies {
        if dependency == *name {
          return Err(Error::Precondition(format!(
            "Generated field `{name}` cannot reference itself"
          )));
        }
        let Some(dep) = request.attributes.get(&dependency) else {
          return Err(Error::Precondition(format!(
            "Generated field `{name}` references unknown field `{dependency}`"
          )));
        };
        if !supports_generated(&dep.field_type) {
          return Err(Error::Precondition(format!(
            "Generated field `{name}` depends on unsupported field `{dependency}`"
          )));
        }
      }
    }
    if attribute.field_type == "enumeration"
      && (attribute.enum_values.is_empty()
        || attribute
          .enum_values
          .iter()
          .any(|value| value.trim().is_empty())
        || attribute
          .enum_values
          .iter()
          .collect::<std::collections::BTreeSet<_>>()
          .len()
          != attribute.enum_values.len())
    {
      return Err(Error::Precondition(format!(
        "Enumeration field `{name}` must have unique, non-empty values"
      )));
    }
    if attribute.field_type == "relation" && attribute.relation_target.is_none() {
      return Err(Error::Precondition(format!(
        "Relation field `{name}` must select a target content type"
      )));
    }
    if attribute.field_type == "relation" {
      let cardinality = attribute
        .relation_cardinality
        .as_deref()
        .unwrap_or("manyToOne");
      if !matches!(cardinality, "manyToOne" | "manyToMany") {
        return Err(Error::Precondition(format!(
          "Unsupported relation cardinality `{cardinality}` for `{name}`"
        )));
      }
      let relation_attributes = attribute
        .relation_attributes
        .as_ref()
        .filter(|attributes| !attributes.is_empty());
      if relation_attributes.is_some() && cardinality != "manyToMany" {
        return Err(Error::Precondition(format!(
          "Only many-to-many relations can define additional attributes (`{name}`)"
        )));
      }
      if let Some(relation_attributes) = relation_attributes {
        if relation_attributes.values().any(|field| {
          field.field_type == "relation"
            && (field.relation_cardinality.as_deref() == Some("manyToMany")
              || field
                .relation_attributes
                .as_ref()
                .is_some_and(|attributes| !attributes.is_empty()))
        }) {
          return Err(Error::Precondition(format!(
            "Relation fields inside many-to-many attributes must be many-to-one (`{name}`)"
          )));
        }
        let nested = CreateContentTypeRequest {
          uid: request.uid.clone(),
          kind: "collectionType".to_string(),
          info: request.info.clone(),
          attributes: relation_attributes.clone(),
        };
        validate_content_type(&nested)?;
      }
    } else if attribute.relation_cardinality.is_some()
      || attribute
        .relation_attributes
        .as_ref()
        .is_some_and(|attributes| !attributes.is_empty())
    {
      return Err(Error::Precondition(format!(
        "Only relation fields can define relation metadata (`{name}`)"
      )));
    }
    if let Some(target) = &attribute.relation_target {
      validate_uid(target)?;
    }
    if attribute.field_type != "relation" && attribute.relation_target.is_some() {
      return Err(Error::Precondition(format!(
        "Only relation fields can have a relation target (`{name}`)"
      )));
    }
  }
  let mut visiting = BTreeSet::new();
  let mut visited = BTreeSet::new();
  for (name, attribute) in &request.attributes {
    if attribute.computed
      && has_generated_cycle(name, &request.attributes, &mut visiting, &mut visited)
    {
      return Err(Error::Precondition(format!(
        "Generated fields contain a circular dependency at `{name}`"
      )));
    }
  }
  Ok(())
}

fn table_columns(
  attributes: &BTreeMap<String, ContentTypeAttribute>,
  relation_tables: &BTreeMap<String, String>,
) -> Result<Vec<String>, Error> {
  let mut columns = vec![
    "\"id\" INTEGER PRIMARY KEY AUTOINCREMENT".to_string(),
    "\"created_at\" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP".to_string(),
    "\"updated_at\" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP".to_string(),
  ];
  for (name, attribute) in attributes {
    if is_many_to_many(attribute) {
      continue;
    }
    let mut definition = format!(
      "{} {}",
      quote_identifier(name),
      field_sql_type(&attribute.field_type)?
    );
    if attribute.required && !attribute.computed && !is_sql_view_default(attribute) {
      definition.push_str(" NOT NULL");
    }
    if attribute.unique && !attribute.computed {
      definition.push_str(" UNIQUE");
    }
    if attribute.field_type == "uid" && !attribute.unique && !attribute.computed {
      definition.push_str(" UNIQUE");
    }
    if let Some(default) = &attribute.default {
      if !attribute.computed && !is_sql_view_default(attribute) {
        definition.push_str(&format!(" DEFAULT {}", sql_literal(default)?));
      }
    }
    if attribute.field_type == "json" {
      definition.push_str(" CHECK(json_valid(");
      definition.push_str(&quote_identifier(name));
      definition.push_str("))");
    }
    if attribute.field_type == "media" {
      definition.push_str(" CHECK(json_valid(");
      definition.push_str(&quote_identifier(name));
      definition.push_str("))");
    }
    if attribute.field_type == "boolean" {
      definition.push_str(" CHECK(");
      definition.push_str(&quote_identifier(name));
      definition.push_str(" IN (0, 1))");
    }
    if attribute.field_type == "enumeration" {
      let values = attribute
        .enum_values
        .iter()
        .map(|value| format!("'{}'", value.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ");
      definition.push_str(" CHECK(");
      definition.push_str(&quote_identifier(name));
      definition.push_str(&format!(" IN ({values}))"));
    }
    if let Some(min) = &attribute.min {
      definition.push_str(&format!(
        " CHECK({} >= {})",
        quote_identifier(name),
        sql_literal(min)?
      ));
    }
    if let Some(max) = &attribute.max {
      definition.push_str(&format!(
        " CHECK({} <= {})",
        quote_identifier(name),
        sql_literal(max)?
      ));
    }
    if let Some(min) = attribute.min_length {
      definition.push_str(&format!(
        " CHECK(length({}) >= {min})",
        quote_identifier(name)
      ));
    }
    if let Some(max) = attribute.max_length {
      definition.push_str(&format!(
        " CHECK(length({}) <= {max})",
        quote_identifier(name)
      ));
    }
    if let Some(pattern) = &attribute.regex {
      definition.push_str(&format!(
        " CHECK({} REGEXP '{}')",
        quote_identifier(name),
        pattern.replace('\'', "''")
      ));
    }
    if attribute.field_type == "relation" {
      let target_uid = attribute.relation_target.as_deref().ok_or_else(|| {
        Error::Precondition(format!("Relation field `{name}` is missing its target"))
      })?;
      let target_table = relation_tables.get(target_uid).ok_or_else(|| {
        Error::Precondition(format!("Related collection `{target_uid}` was not found"))
      })?;
      definition.push_str(&format!(
        " REFERENCES {} (id) ON DELETE {}",
        quote_identifier(target_table),
        if attribute.required {
          "RESTRICT"
        } else {
          "SET NULL"
        }
      ));
    }
    if attribute.computed && attribute.rollup.is_none() {
      let expression = attribute.expression.as_deref().ok_or_else(|| {
        Error::Precondition(format!(
          "Generated field `{name}` is missing its expression"
        ))
      })?;
      definition.push_str(&format!(
        " GENERATED ALWAYS AS ({expression}) {}",
        if attribute.stored.unwrap_or(true) {
          "STORED"
        } else {
          "VIRTUAL"
        }
      ));
    }
    columns.push(definition);
  }
  Ok(columns)
}

fn is_many_to_many(attribute: &ContentTypeAttribute) -> bool {
  attribute.field_type == "relation"
    && attribute.relation_cardinality.as_deref() == Some("manyToMany")
}

fn relation_targets(attributes: &BTreeMap<String, ContentTypeAttribute>) -> BTreeSet<&str> {
  fn collect<'a>(attribute: &'a ContentTypeAttribute, targets: &mut BTreeSet<&'a str>) {
    if attribute.field_type == "relation"
      && let Some(target) = attribute.relation_target.as_deref()
    {
      targets.insert(target);
    }
    if let Some(nested) = &attribute.relation_attributes {
      for attribute in nested.values() {
        collect(attribute, targets);
      }
    }
  }

  let mut targets = BTreeSet::new();
  for attribute in attributes.values() {
    collect(attribute, &mut targets);
  }
  targets
}

fn many_to_many_table_name(source_table: &str, relation_name: &str) -> String {
  format!("{source_table}_rel_{relation_name}")
}

fn content_type_trigger_names(schema: &ContentTypeSchema, table_name: &str) -> BTreeSet<String> {
  let mut names = BTreeSet::from([format!("{table_name}_sql_defaults_insert")]);
  for (relation_name, attribute) in &schema.attributes {
    if !is_many_to_many(attribute) {
      continue;
    }
    let relation_table = many_to_many_table_name(table_name, relation_name);
    names.extend([
      format!("{relation_table}_sql_defaults_insert"),
      format!("{relation_table}_rollup_insert"),
      format!("{relation_table}_rollup_delete"),
      format!("{relation_table}_rollup_update"),
      format!("{table_name}_rollup_insert_guard_{relation_name}"),
      format!("{table_name}_rollup_update_guard_{relation_name}"),
      format!("{table_name}_rollup_init_{relation_name}"),
    ]);
  }
  names
}

fn drop_content_type_trigger_statements(
  schema: &ContentTypeSchema,
  table_name: &str,
) -> Vec<String> {
  content_type_trigger_names(schema, table_name)
    .into_iter()
    .map(|name| format!("DROP TRIGGER IF EXISTS {}", quote_identifier(&name)))
    .collect()
}

fn many_to_many_table_sql(
  table_name: &str,
  source_table: &str,
  attribute: &ContentTypeAttribute,
  target_table: &str,
  relation_tables: &BTreeMap<String, String>,
) -> Result<String, Error> {
  let mut columns = vec![
    "\"id\" INTEGER PRIMARY KEY AUTOINCREMENT".to_string(),
    format!(
      "\"source_id\" INTEGER NOT NULL REFERENCES {} (id) ON DELETE CASCADE",
      quote_identifier(source_table)
    ),
    format!(
      "\"target_id\" INTEGER NOT NULL REFERENCES {} (id) ON DELETE RESTRICT",
      quote_identifier(target_table)
    ),
    "\"created_at\" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP".to_string(),
    "\"updated_at\" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP".to_string(),
  ];
  let fields = attribute
    .relation_attributes
    .as_ref()
    .cloned()
    .unwrap_or_default();
  columns.extend(table_columns(&fields, relation_tables)?.into_iter().skip(3));
  if fields.is_empty() {
    columns.push("UNIQUE (\"source_id\", \"target_id\")".to_string());
  }
  Ok(format!(
    "CREATE TABLE {} ({}) STRICT",
    quote_identifier(table_name),
    columns.join(", ")
  ))
}

fn sql_default_trigger_statement(
  table_name: &str,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
) -> Option<String> {
  let defaults = attributes
    .iter()
    .filter_map(|(name, attribute)| {
      sql_view_default(attribute).map(|sql| (name, attribute, sql.trim()))
    })
    .collect::<Vec<_>>();
  if defaults.is_empty() {
    return None;
  }

  let assignments = defaults
    .iter()
    .map(|(name, _, sql)| {
      let column = quote_identifier(name);
      format!("{column} = CASE WHEN NEW.{column} IS NULL THEN ({sql}) ELSE NEW.{column} END")
    })
    .collect::<Vec<_>>()
    .join(", ");
  let required_checks = defaults
    .iter()
    .filter(|(_, attribute, _)| attribute.required)
    .map(|(name, _, _)| {
      let column = quote_identifier(name);
      let message = format!("Required SQL default `{name}` returned NULL").replace('\'', "''");
      format!(
        "SELECT CASE WHEN (SELECT {column} FROM {table} WHERE \"id\" = NEW.\"id\") IS NULL \
         THEN RAISE(ABORT, '{message}') END;",
        table = quote_identifier(table_name)
      )
    })
    .collect::<Vec<_>>()
    .join(" ");

  Some(format!(
    "CREATE TRIGGER {} AFTER INSERT ON {} BEGIN \
       UPDATE {} SET {assignments} WHERE \"id\" = NEW.\"id\"; \
       {required_checks} \
     END",
    quote_identifier(&format!("{table_name}_sql_defaults_insert")),
    quote_identifier(table_name),
    quote_identifier(table_name)
  ))
}

fn rollup_fields_for_relation<'a>(
  attributes: &'a BTreeMap<String, ContentTypeAttribute>,
  relation_name: &str,
) -> Vec<(&'a str, &'a ContentTypeAttribute, &'a ContentTypeRollup)> {
  attributes
    .iter()
    .filter_map(|(name, attribute)| {
      attribute
        .rollup
        .as_ref()
        .filter(|rollup| rollup.relation == relation_name)
        .map(|rollup| (name.as_str(), attribute, rollup))
    })
    .collect()
}

fn rollup_sum_expression(
  relation_table: &str,
  rollup: &ContentTypeRollup,
  source_id: &str,
) -> String {
  format!(
    "COALESCE((SELECT SUM({field}) FROM {relation_table} WHERE \"source_id\" = {source_id}), 0)",
    field = quote_identifier(&rollup.field),
    relation_table = quote_identifier(relation_table)
  )
}

fn rollup_trigger_statements(
  source_table: &str,
  relation_name: &str,
  relation_table: &str,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
) -> Vec<String> {
  let fields = rollup_fields_for_relation(attributes, relation_name);
  if fields.is_empty() {
    return Vec::new();
  }

  let update_for = |source_id: &str| {
    fields
      .iter()
      .map(|(name, _, rollup)| {
        format!(
          "{} = {}",
          quote_identifier(name),
          rollup_sum_expression(relation_table, rollup, source_id)
        )
      })
      .collect::<Vec<_>>()
      .join(", ")
  };
  let target_names = fields
    .iter()
    .map(|(name, _, _)| quote_identifier(name))
    .collect::<Vec<_>>()
    .join(", ");
  // Keep the target table unaliased in UPDATE statements. SQLite does not
  // consistently resolve an UPDATE alias inside the correlated aggregate
  // subquery used by the rollup assignment.
  let source_row_id = format!("{}.\"id\"", quote_identifier(source_table));
  let mut statements = vec![
    format!(
      "CREATE TRIGGER {} AFTER INSERT ON {} BEGIN \
         UPDATE {} SET {} WHERE \"id\" = NEW.\"source_id\"; \
       END",
      quote_identifier(&format!("{relation_table}_rollup_insert")),
      quote_identifier(relation_table),
      quote_identifier(source_table),
      update_for("NEW.\"source_id\"")
    ),
    format!(
      "CREATE TRIGGER {} AFTER DELETE ON {} BEGIN \
         UPDATE {} SET {} WHERE \"id\" = OLD.\"source_id\"; \
       END",
      quote_identifier(&format!("{relation_table}_rollup_delete")),
      quote_identifier(relation_table),
      quote_identifier(source_table),
      update_for("OLD.\"source_id\"")
    ),
    format!(
      "CREATE TRIGGER {} AFTER UPDATE ON {} BEGIN \
         UPDATE {} SET {} WHERE \"id\" IN (OLD.\"source_id\", NEW.\"source_id\"); \
       END",
      quote_identifier(&format!("{relation_table}_rollup_update")),
      quote_identifier(relation_table),
      quote_identifier(source_table),
      update_for(&source_row_id)
    ),
  ];

  // A rollup is stored for fast reads but remains read-only to ordinary writes.
  // The only accepted values are the current aggregate values.
  let mut insert_checks = Vec::new();
  let mut update_checks = Vec::new();
  let mut insert_assignments = Vec::new();
  for (name, _, rollup) in &fields {
    let column = quote_identifier(name);
    let expected = rollup_sum_expression(relation_table, rollup, "NEW.\"id\"");
    insert_checks.push(format!(
      "(NEW.{column} IS NOT NULL AND NEW.{column} IS NOT {expected})"
    ));
    update_checks.push(format!("(NEW.{column} IS NOT {expected})"));
    insert_assignments.push(format!("{column} = {expected}"));
  }
  let check_expr = insert_checks.join(" OR ");
  let update_check_expr = update_checks.join(" OR ");
  let message = "Stored relation rollups are read-only";
  statements.push(format!(
    "CREATE TRIGGER {} BEFORE INSERT ON {} WHEN {check_expr} \
       BEGIN SELECT RAISE(ABORT, '{message}'); END",
    quote_identifier(&format!(
      "{source_table}_rollup_insert_guard_{relation_name}"
    )),
    quote_identifier(source_table)
  ));
  statements.push(format!(
    "CREATE TRIGGER {} BEFORE UPDATE OF {target_names} ON {} WHEN {update_check_expr} \
       BEGIN SELECT RAISE(ABORT, '{message}'); END",
    quote_identifier(&format!(
      "{source_table}_rollup_update_guard_{relation_name}"
    )),
    quote_identifier(source_table)
  ));
  statements.push(format!(
    "CREATE TRIGGER {} AFTER INSERT ON {} BEGIN UPDATE {} SET {} WHERE \"id\" = NEW.\"id\"; END",
    quote_identifier(&format!("{source_table}_rollup_init_{relation_name}")),
    quote_identifier(source_table),
    quote_identifier(source_table),
    insert_assignments.join(", ")
  ));
  statements.push(format!(
    "UPDATE {} SET {}",
    quote_identifier(source_table),
    update_for(&source_row_id)
  ));
  statements
}

fn many_to_many_table_statements(
  source_table: &str,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
  relation_tables: &BTreeMap<String, String>,
) -> Result<Vec<String>, Error> {
  attributes
    .iter()
    .filter(|(_, attribute)| is_many_to_many(attribute))
    .try_fold(Vec::new(), |mut statements, (name, attribute)| {
      let target_uid = attribute.relation_target.as_deref().ok_or_else(|| {
        Error::Precondition(format!("Relation field `{name}` is missing its target"))
      })?;
      let target_table = relation_tables.get(target_uid).ok_or_else(|| {
        Error::Precondition(format!("Related collection `{target_uid}` was not found"))
      })?;
      let relation_table = many_to_many_table_name(source_table, name);
      statements.push(many_to_many_table_sql(
        &relation_table,
        source_table,
        attribute,
        target_table,
        relation_tables,
      )?);
      if let Some(trigger) = sql_default_trigger_statement(
        &relation_table,
        attribute
          .relation_attributes
          .as_ref()
          .unwrap_or(&BTreeMap::new()),
      ) {
        statements.push(trigger);
      }
      statements.extend(rollup_trigger_statements(
        source_table,
        name,
        &relation_table,
        attributes,
      ));
      Ok(statements)
    })
}

async fn relation_table_names(
  conn: &trailbase_sqlite::Connection,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
  own_uid: &str,
  own_table_name: &str,
) -> Result<BTreeMap<String, String>, Error> {
  let mut names = BTreeMap::new();
  let targets = relation_targets(attributes);
  for target_uid in targets {
    if target_uid == own_uid {
      names.insert(target_uid.to_string(), own_table_name.to_string());
      continue;
    }
    let kind: Option<String> = conn
      .read_query_row_get(
        format!("SELECT kind FROM {REGISTRY_TABLE} WHERE uid = ?"),
        trailbase_sqlite::params!(target_uid.to_string()),
        0,
      )
      .await?;
    if kind.as_deref() != Some("collectionType") {
      return Err(Error::Precondition(format!(
        "Relation target `{target_uid}` must be a collection type"
      )));
    }
    let table_name: Option<String> = conn
      .read_query_row_get(
        format!("SELECT table_name FROM {REGISTRY_TABLE} WHERE uid = ?"),
        trailbase_sqlite::params!(target_uid.to_string()),
        0,
      )
      .await?;
    let table_name = table_name.ok_or_else(|| {
      Error::Precondition(format!("Related collection `{target_uid}` was not found"))
    })?;
    names.insert(target_uid.to_string(), table_name);
  }
  Ok(names)
}

fn record_api_config(schema: &ContentTypeSchema, table_name: &str) -> proto::RecordApiConfig {
  proto::RecordApiConfig {
    name: Some(schema.info.plural_name.clone()),
    table_name: Some(table_name.to_string()),
    acl_world: vec![PermissionFlag::Read as i32],
    acl_authenticated: vec![
      PermissionFlag::Create as i32,
      PermissionFlag::Read as i32,
      PermissionFlag::Update as i32,
      PermissionFlag::Delete as i32,
      PermissionFlag::Schema as i32,
    ],
    excluded_columns: schema
      .attributes
      .iter()
      .filter_map(|(name, attribute)| attribute.private.then_some(name.clone()))
      .collect(),
    create_access_rule: (schema.kind == "singleType").then(|| {
      format!(
        "NOT EXISTS (SELECT 1 FROM {})",
        quote_identifier(table_name)
      )
    }),
    enable_subscriptions: Some(true),
    ..Default::default()
  }
}

async fn connection(state: &AppState) -> Result<trailbase_sqlite::Connection, Error> {
  let entry = state.connection_manager().main_entry();
  if entry.connection.connection_type() != ConnectionType::Sqlite {
    return Err(Error::Precondition(
      "Content types currently require a SQLite database".into(),
    ));
  }
  Ok(entry.connection.clone())
}

async fn ensure_registry(conn: &trailbase_sqlite::Connection) -> Result<(), Error> {
  conn
    .execute_batch(format!(
      "CREATE TABLE IF NOT EXISTS {REGISTRY_TABLE} (\
         uid TEXT PRIMARY KEY, kind TEXT NOT NULL, table_name TEXT NOT NULL UNIQUE, \
         schema_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\
       );"
    ))
    .await?;
  Ok(())
}

async fn load_all(conn: &trailbase_sqlite::Connection) -> Result<Vec<ContentTypeSchema>, Error> {
  ensure_registry(conn).await?;
  let rows = conn
    .read_query_rows(
      format!("SELECT schema_json FROM {REGISTRY_TABLE} ORDER BY uid"),
      (),
    )
    .await?;
  let mut schemas = Vec::with_capacity(rows.len());
  for row in rows {
    let json: String = row.get(0)?;
    let mut schema: ContentTypeSchema = serde_json::from_str(&json)?;
    let normalized_views = normalize_default_views(schema.views.clone());
    if normalized_views != schema.views {
      schema.views = normalized_views;
      let serialized = serde_json::to_string(&schema)?;
      conn
        .write_query_row(
          format!("UPDATE {REGISTRY_TABLE} SET schema_json = ? WHERE uid = ?"),
          trailbase_sqlite::params!(serialized, schema.uid.clone()),
        )
        .await?;
    }
    schemas.push(schema);
  }
  Ok(schemas)
}

#[utoipa::path(
  get,
  path = "/content-types",
  tag = "content-types",
  responses((status = 200, description = "Content type definitions", body = ContentTypesResponse))
)]
pub async fn list_content_types(
  State(state): State<AppState>,
) -> Result<Json<ContentTypesResponse>, Error> {
  let conn = connection(&state).await?;
  Ok(Json(ContentTypesResponse {
    data: load_all(&conn).await?,
  }))
}

#[utoipa::path(
  get,
  path = "/content-types/{uid}",
  tag = "content-types",
  params(("uid" = String, Path, description = "Content type uid")),
  responses((status = 200, description = "Content type definition", body = ContentTypeResponse))
)]
pub async fn get_content_type(
  State(state): State<AppState>,
  Path(uid): Path<String>,
) -> Result<Json<ContentTypeResponse>, Error> {
  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;
  let json: Option<String> = conn
    .read_query_row_get(
      format!("SELECT schema_json FROM {REGISTRY_TABLE} WHERE uid = ?"),
      trailbase_sqlite::params!(uid),
      0,
    )
    .await?;
  let json = json.ok_or_else(|| Error::Precondition("Content type not found".into()))?;
  Ok(Json(ContentTypeResponse {
    data: serde_json::from_str(&json)?,
  }))
}

#[utoipa::path(
  put,
  path = "/content-types/{uid}/views",
  tag = "content-types",
  params(("uid" = String, Path, description = "Existing content type uid")),
  request_body = ContentTypeViews,
  responses((status = 200, description = "Updated content type views", body = ContentTypeResponse))
)]
pub async fn update_content_type_views(
  State(state): State<AppState>,
  Path(uid): Path<String>,
  Json(views): Json<ContentTypeViews>,
) -> Result<Json<ContentTypeResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  if views.version != 1 {
    return Err(Error::Precondition(
      "Unsupported content view format version".into(),
    ));
  }
  let mut ids = BTreeSet::new();
  if views.views.iter().any(|view| {
    view.id.is_empty()
      || view.name.trim().is_empty()
      || (view.id == "form" && view.view_type != "form")
      || (view.id != "form" && view.view_type != "table")
      || (view.id != "table" && view.id != "form" && view.is_default)
      || !ids.insert(view.id.as_str())
  }) {
    return Err(Error::Precondition(
      "Views need unique ids, names, and a supported view type".into(),
    ));
  }
  let table_view = views.views.iter().find(|view| view.id == "table");
  let form_view = views.views.iter().find(|view| view.id == "form");
  let canonical_view = |view: Option<&ContentTypeView>, id: &str, name: &str| {
    view.is_some_and(|view| {
      view.name == name
        && view.is_default
        && view.view_type == id
        && view.filter.is_empty()
        && view.sort.is_empty()
        && view.columns.is_empty()
    })
  };
  if !canonical_view(table_view, "table", "Table")
    || !canonical_view(form_view, "form", "Form")
    || !ids.contains(views.selected_view_id.as_str())
  {
    return Err(Error::Precondition(
      "Views must include the unmodified default table and form views and select an existing view"
        .into(),
    ));
  }

  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;
  let schema_json: Option<String> = conn
    .read_query_row_get(
      format!("SELECT schema_json FROM {REGISTRY_TABLE} WHERE uid = ?"),
      trailbase_sqlite::params!(uid.clone()),
      0,
    )
    .await?;
  let mut schema: ContentTypeSchema = serde_json::from_str(
    &schema_json.ok_or_else(|| Error::Precondition("Content type not found".into()))?,
  )?;
  schema.views = views;
  let serialized = serde_json::to_string(&schema)?;
  conn
    .write_query_row(
      format!("UPDATE {REGISTRY_TABLE} SET schema_json = ? WHERE uid = ?"),
      trailbase_sqlite::params!(serialized, uid),
    )
    .await?;

  Ok(Json(ContentTypeResponse { data: schema }))
}

#[utoipa::path(
  post,
  path = "/content-types",
  tag = "content-types",
  request_body = CreateContentTypeRequest,
  responses((status = 200, description = "Created content type", body = ContentTypeResponse))
)]
pub async fn create_content_type(
  State(state): State<AppState>,
  Json(request): Json<CreateContentTypeRequest>,
) -> Result<Json<ContentTypeResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  validate_content_type(&request)?;

  let table_name = format!("ct_{}", request.uid.replace('.', "_").replace(':', "_"));
  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;

  let config_before_create = state.get_config();
  if config_before_create
    .record_apis
    .iter()
    .any(|api| api.name.as_deref() == Some(request.info.plural_name.as_str()))
  {
    return Err(Error::AlreadyExists("record API name"));
  }

  let exists: bool = conn
    .read_query_row_get(
      format!("SELECT EXISTS(SELECT 1 FROM {REGISTRY_TABLE} WHERE uid = ? OR table_name = ?)"),
      trailbase_sqlite::params!(request.uid.clone(), table_name.clone()),
      0,
    )
    .await?
    .unwrap_or(false);
  if exists {
    return Err(Error::AlreadyExists("content type uid"));
  }

  let relation_tables =
    relation_table_names(&conn, &request.attributes, &request.uid, &table_name).await?;
  let attributes = normalize_attributes(request.attributes)?;
  let columns = table_columns(&attributes, &relation_tables)?;
  let mut relation_sql = many_to_many_table_statements(&table_name, &attributes, &relation_tables)?;
  if let Some(trigger) = sql_default_trigger_statement(&table_name, &attributes) {
    relation_sql.push(trigger);
  }

  let schema = ContentTypeSchema {
    uid: request.uid,
    kind: request.kind,
    info: request.info,
    attributes,
    table_name: Some(table_name.clone()),
    views: ContentTypeViews::default(),
  };
  let serialized = serde_json::to_string(&schema)?;
  let create_sql = format!(
    "CREATE TABLE {} ({}) STRICT",
    quote_identifier(&table_name),
    columns.join(", ")
  );
  let tx_log = conn
    .transaction(move |tx| {
      let mut tx = TransactionRecorder::new(tx);
      tx.execute(create_sql, ())?;
      for statement in relation_sql {
        tx.execute(statement, ())?;
      }
      tx.rollback()
        .map_err(|err| trailbase_sqlite::Error::Other(err.into()))
    })
    .await?;
  if let Some(ref log) = tx_log {
    log
      .apply_as_migration(
        &conn,
        state.data_dir().migrations_path().join("main"),
        &format!("{table_name}_create_table"),
      )
      .await?;
  }
  conn
    .write_query_row(
      format!(
        "INSERT INTO {REGISTRY_TABLE} (uid, kind, table_name, schema_json) VALUES (?, ?, ?, ?)"
      ),
      trailbase_sqlite::params!(
        schema.uid.clone(),
        schema.kind.clone(),
        table_name.clone(),
        serialized.clone()
      ),
    )
    .await?;
  state.rebuild_connection_metadata().await?;

  let mut config = (*state.get_config()).clone();
  let old_config_hash = proto::hash_config(&config);
  config
    .record_apis
    .push(record_api_config(&schema, &table_name));
  state
    .validate_and_update_config(config, Some(old_config_hash))
    .await?;

  Ok(Json(ContentTypeResponse { data: schema }))
}

#[utoipa::path(
  put,
  path = "/content-types/{uid}",
  tag = "content-types",
  params(("uid" = String, Path, description = "Existing content type uid")),
  request_body = UpdateContentTypeRequest,
  responses((status = 200, description = "Updated content type", body = ContentTypeResponse))
)]
pub async fn update_content_type(
  State(state): State<AppState>,
  Path(old_uid): Path<String>,
  Json(request): Json<UpdateContentTypeRequest>,
) -> Result<Json<ContentTypeResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  let UpdateContentTypeRequest {
    schema: request,
    renamed_attributes,
  } = request;
  validate_content_type(&request)?;

  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;
  let old_json: Option<String> = conn
    .read_query_row_get(
      format!("SELECT schema_json FROM {REGISTRY_TABLE} WHERE uid = ?"),
      trailbase_sqlite::params!(old_uid.clone()),
      0,
    )
    .await?;
  let old_schema: ContentTypeSchema = serde_json::from_str(
    &old_json.ok_or_else(|| Error::Precondition("Content type not found".into()))?,
  )?;
  if old_uid != request.uid
    && load_all(&conn).await?.iter().any(|schema| {
      schema
        .attributes
        .values()
        .any(|attribute| attribute.relation_target.as_deref() == Some(old_uid.as_str()))
    })
  {
    return Err(Error::Precondition(
      "Cannot change this UID while another content type has a relation to it".into(),
    ));
  }
  let table_name = old_schema
    .table_name
    .clone()
    .ok_or_else(|| Error::Precondition("Missing content table".into()))?;
  for (old_name, new_name) in &renamed_attributes {
    if !old_schema.attributes.contains_key(old_name)
      || !request.attributes.contains_key(new_name)
      || old_name == new_name
    {
      return Err(Error::Precondition(format!(
        "Invalid field rename from `{old_name}` to `{new_name}`"
      )));
    }
  }

  let config_before_update = state.get_config();
  if config_before_update.record_apis.iter().any(|api| {
    api.name.as_deref() == Some(request.info.plural_name.as_str())
      && api.table_name.as_deref() != Some(table_name.as_str())
  }) {
    return Err(Error::AlreadyExists("record API name"));
  }
  let uid_exists: bool = conn
    .read_query_row_get(
      format!("SELECT EXISTS(SELECT 1 FROM {REGISTRY_TABLE} WHERE uid = ? AND uid != ?)"),
      trailbase_sqlite::params!(request.uid.clone(), old_uid.clone()),
      0,
    )
    .await?
    .unwrap_or(false);
  if uid_exists {
    return Err(Error::AlreadyExists("content type uid"));
  }

  let row_count: i64 = conn
    .read_query_row_get(
      format!("SELECT COUNT(*) FROM {}", quote_identifier(&table_name)),
      (),
      0,
    )
    .await?
    .unwrap_or(0);
  for (name, attribute) in &request.attributes {
    let source_name = renamed_attributes
      .iter()
      .find_map(|(old, new)| (new == name).then_some(old))
      .unwrap_or(name);
    if attribute.required
      && !is_sql_view_default(attribute)
      && !old_schema.attributes.contains_key(source_name)
      && row_count > 0
    {
      return Err(Error::Precondition(format!(
        "Cannot add required field `{name}` while records already exist"
      )));
    }
  }

  let attributes = normalize_attributes(request.attributes)?;
  let schema = ContentTypeSchema {
    uid: request.uid,
    kind: request.kind,
    info: request.info,
    attributes,
    table_name: Some(table_name.clone()),
    views: old_schema.views,
  };

  let old_table_sql: Option<String> = conn
    .read_query_row_get(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      trailbase_sqlite::params!(table_name.clone()),
      0,
    )
    .await?;
  let old_table_is_strict = old_table_sql.as_deref().is_some_and(|sql| {
    sql
      .trim_end_matches(';')
      .trim_end()
      .to_ascii_uppercase()
      .ends_with("STRICT")
  });

  if schema.attributes != old_schema.attributes || !old_table_is_strict {
    let temporary_name = format!(
      "{table_name}_content_type_{}",
      uuid::Uuid::new_v4().simple()
    );
    let relation_tables =
      relation_table_names(&conn, &schema.attributes, &schema.uid, &table_name).await?;
    let definitions = table_columns(&schema.attributes, &relation_tables)?;
    let create_sql = format!(
      "CREATE TABLE {} ({}) STRICT",
      quote_identifier(&temporary_name),
      definitions.join(", ")
    );
    let mut columns = vec![
      "id".to_string(),
      "created_at".to_string(),
      "updated_at".to_string(),
    ];
    let mut expressions = columns
      .iter()
      .map(|name| quote_identifier(name))
      .collect::<Vec<_>>();
    for (name, attribute) in &schema.attributes {
      if attribute.computed || is_many_to_many(attribute) {
        continue;
      }
      columns.push(name.clone());
      let source_name = renamed_attributes
        .iter()
        .find_map(|(old, new)| (new == name).then_some(old))
        .unwrap_or(name);
      if old_schema
        .attributes
        .get(source_name)
        .is_some_and(|attribute| !is_many_to_many(attribute))
      {
        let column = quote_identifier(source_name);
        let old_type = &old_schema.attributes[source_name].field_type;
        if old_type != &attribute.field_type {
          expressions.push(format!(
            "CAST({column} AS {})",
            field_sql_type(&attribute.field_type)?
          ));
        } else {
          expressions.push(column);
        }
      } else {
        expressions.push("NULL".to_string());
      }
    }
    let copy_sql = format!(
      "INSERT INTO {} ({}) SELECT {} FROM {}",
      quote_identifier(&temporary_name),
      columns
        .iter()
        .map(|name| quote_identifier(name))
        .collect::<Vec<_>>()
        .join(", "),
      expressions.join(", "),
      quote_identifier(&table_name),
    );
    let rename_sql = format!(
      "ALTER TABLE {} RENAME TO {}",
      quote_identifier(&temporary_name),
      quote_identifier(&table_name),
    );
    let old_table = quote_identifier(&table_name);
    let relation_sql =
      many_to_many_table_statements(&table_name, &schema.attributes, &relation_tables)?;
    let mut statements = Vec::new();
    let mut staged_relations = BTreeMap::new();
    for (old_name, old_attribute) in &old_schema.attributes {
      if !is_many_to_many(old_attribute) {
        continue;
      }
      let relation_table = many_to_many_table_name(&table_name, old_name);
      let exists: bool = conn
        .read_query_row_get(
          "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
          trailbase_sqlite::params!(relation_table.clone()),
          0,
        )
        .await?
        .unwrap_or(false);
      if !exists {
        continue;
      }
      let staging_table = format!("{relation_table}_stage_{}", uuid::Uuid::new_v4().simple());
      statements.push(format!(
        "CREATE TABLE {} AS SELECT * FROM {}",
        quote_identifier(&staging_table),
        quote_identifier(&relation_table)
      ));
      statements.push(format!("DROP TABLE {}", quote_identifier(&relation_table)));
      staged_relations.insert(old_name.clone(), staging_table);
    }
    statements.extend([create_sql, copy_sql]);
    statements.push(format!("DROP TABLE {old_table}"));
    statements.push(rename_sql);
    statements.extend(relation_sql);
    if let Some(trigger) = sql_default_trigger_statement(&table_name, &schema.attributes) {
      statements.push(trigger);
    }
    for (new_name, new_attribute) in &schema.attributes {
      if !is_many_to_many(new_attribute) {
        continue;
      }
      let old_name = renamed_attributes
        .iter()
        .find_map(|(old, new)| (new == new_name).then_some(old.as_str()))
        .unwrap_or(new_name);
      let Some(staging_table) = staged_relations.get(old_name) else {
        continue;
      };
      let Some(old_attribute) = old_schema.attributes.get(old_name) else {
        continue;
      };
      let mut columns = vec![
        "id".to_string(),
        "source_id".to_string(),
        "target_id".to_string(),
        "created_at".to_string(),
        "updated_at".to_string(),
      ];
      let mut expressions = columns
        .iter()
        .map(|name| quote_identifier(name))
        .collect::<Vec<_>>();
      for (field_name, new_field) in new_attribute
        .relation_attributes
        .as_ref()
        .into_iter()
        .flat_map(|fields| fields.iter())
      {
        let Some(old_field) = old_attribute
          .relation_attributes
          .as_ref()
          .and_then(|fields| fields.get(field_name))
        else {
          continue;
        };
        if new_field.computed || old_field.computed {
          continue;
        }
        columns.push(field_name.clone());
        let column = quote_identifier(field_name);
        expressions.push(if old_field.field_type == new_field.field_type {
          column
        } else {
          format!(
            "CAST({column} AS {})",
            field_sql_type(&new_field.field_type)?
          )
        });
      }
      let target_table = many_to_many_table_name(&table_name, new_name);
      statements.push(format!(
        "INSERT INTO {} ({}) SELECT {} FROM {}",
        quote_identifier(&target_table),
        columns
          .iter()
          .map(|name| quote_identifier(name))
          .collect::<Vec<_>>()
          .join(", "),
        expressions.join(", "),
        quote_identifier(staging_table)
      ));
    }
    for (_, staging_table) in staged_relations {
      statements.push(format!("DROP TABLE {}", quote_identifier(&staging_table)));
    }
    let tx_log = conn
      .transaction(move |tx| {
        let mut tx = TransactionRecorder::new(tx);
        for statement in statements {
          tx.execute(statement, ())?;
        }
        tx.rollback()
          .map_err(|err| trailbase_sqlite::Error::Other(err.into()))
      })
      .await?;
    if let Some(ref log) = tx_log {
      log
        .apply_as_migration(
          &conn,
          state.data_dir().migrations_path().join("main"),
          &format!("{table_name}_content_type_update"),
        )
        .await?;
    }
  }

  let serialized = serde_json::to_string(&schema)?;
  conn
    .write_query_row(
      format!("UPDATE {REGISTRY_TABLE} SET uid = ?, kind = ?, schema_json = ? WHERE uid = ?"),
      trailbase_sqlite::params!(schema.uid.clone(), schema.kind.clone(), serialized, old_uid),
    )
    .await?;

  let mut config = (*state.get_config()).clone();
  let old_config_hash = proto::hash_config(&config);
  let updated_api = record_api_config(&schema, &table_name);
  if let Some(api) = config
    .record_apis
    .iter_mut()
    .find(|api| api.table_name.as_deref() == Some(table_name.as_str()))
  {
    *api = updated_api;
  } else {
    // Recover content types whose schema/table was saved but whose API config
    // update failed in an earlier request.
    config.record_apis.push(updated_api);
  }
  state
    .validate_and_update_config(config, Some(old_config_hash))
    .await?;
  state.rebuild_connection_metadata().await?;

  Ok(Json(ContentTypeResponse { data: schema }))
}

#[utoipa::path(
  delete,
  path = "/content-types/{uid}",
  tag = "content-types",
  params(("uid" = String, Path, description = "Content type uid")),
  responses((status = 200, description = "Deleted content type", body = DeleteContentTypeResponse))
)]
pub async fn delete_content_type(
  State(state): State<AppState>,
  Path(uid): Path<String>,
) -> Result<Json<DeleteContentTypeResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;
  let json: Option<String> = conn
    .read_query_row_get(
      format!("SELECT schema_json FROM {REGISTRY_TABLE} WHERE uid = ?"),
      trailbase_sqlite::params!(uid.clone()),
      0,
    )
    .await?;
  let schema: ContentTypeSchema = serde_json::from_str(
    &json.ok_or_else(|| Error::Precondition("Content type not found".into()))?,
  )?;
  if load_all(&conn).await?.iter().any(|other| {
    other.uid != uid
      && other
        .attributes
        .values()
        .any(|attribute| attribute.relation_target.as_deref() == Some(uid.as_str()))
  }) {
    return Err(Error::Precondition(
      "Cannot delete this content type while another type has a relation to it".into(),
    ));
  }
  let table_name = schema
    .table_name
    .clone()
    .ok_or_else(|| Error::Precondition("Missing content table".into()))?;

  let mut config = (*state.get_config()).clone();
  let old_config_hash = proto::hash_config(&config);
  config
    .record_apis
    .retain(|api| api.table_name.as_deref() != Some(&table_name));
  state
    .validate_and_update_config(config, Some(old_config_hash))
    .await?;
  let mut drop_statements = drop_content_type_trigger_statements(&schema, &table_name);
  drop_statements.extend(
    schema
      .attributes
      .iter()
      .filter(|(_, attribute)| is_many_to_many(attribute))
      .map(|(name, _)| {
        format!(
          "DROP TABLE IF EXISTS {}",
          quote_identifier(&many_to_many_table_name(&table_name, name))
        )
      }),
  );
  drop_statements.push(format!("DROP TABLE {}", quote_identifier(&table_name)));
  let tx_log = conn
    .transaction(move |tx| {
      let mut tx = TransactionRecorder::new(tx);
      for statement in drop_statements {
        tx.execute(statement, ())?;
      }
      tx.rollback()
        .map_err(|err| trailbase_sqlite::Error::Other(err.into()))
    })
    .await?;
  if let Some(ref log) = tx_log {
    log
      .apply_as_migration(
        &conn,
        state.data_dir().migrations_path().join("main"),
        &format!("{table_name}_drop_table"),
      )
      .await?;
  }
  conn
    .write_query_row(
      format!("DELETE FROM {REGISTRY_TABLE} WHERE uid = ?"),
      trailbase_sqlite::params!(uid.clone()),
    )
    .await?;
  state.rebuild_connection_metadata().await?;
  Ok(Json(DeleteContentTypeResponse { uid, table_name }))
}

#[utoipa::path(
  delete,
  path = "/content-types",
  tag = "content-types",
  request_body = DeleteContentTypesRequest,
  responses((status = 200, description = "Deleted content types", body = DeleteContentTypesResponse))
)]
pub async fn delete_content_types(
  State(state): State<AppState>,
  Json(request): Json<DeleteContentTypesRequest>,
) -> Result<Json<DeleteContentTypesResponse>, Error> {
  if state.demo_mode() {
    return Err(Error::Precondition("Disallowed in demo".into()));
  }
  let requested_uids: BTreeSet<String> = request.uids.into_iter().collect();
  if requested_uids.is_empty() {
    return Err(Error::Precondition(
      "Select at least one content type to delete".into(),
    ));
  }

  let conn = connection(&state).await?;
  ensure_registry(&conn).await?;
  let schemas = load_all(&conn).await?;
  let selected: Vec<ContentTypeSchema> = schemas
    .iter()
    .filter(|schema| requested_uids.contains(&schema.uid))
    .cloned()
    .collect();
  if selected.len() != requested_uids.len() {
    let found: BTreeSet<_> = selected.iter().map(|schema| schema.uid.as_str()).collect();
    let missing: Vec<_> = requested_uids
      .iter()
      .filter(|uid| !found.contains(uid.as_str()))
      .cloned()
      .collect();
    return Err(Error::Precondition(format!(
      "Content types not found: {}",
      missing.join(", ")
    )));
  }

  let selected_names: BTreeMap<_, _> = selected
    .iter()
    .map(|schema| (schema.uid.as_str(), schema.info.display_name.as_str()))
    .collect();
  let blockers: BTreeSet<String> = schemas
    .iter()
    .filter(|schema| !requested_uids.contains(&schema.uid))
    .flat_map(|schema| {
      relation_targets(&schema.attributes)
        .into_iter()
        .filter(|target| requested_uids.contains(*target))
        .map(|target| {
          format!(
            "{} → {}",
            schema.info.display_name,
            selected_names.get(target).copied().unwrap_or(target)
          )
        })
        .collect::<Vec<_>>()
    })
    .collect();
  if !blockers.is_empty() {
    return Err(Error::Precondition(format!(
      "Cannot delete these content types while unselected types have relations to them: {}",
      blockers.into_iter().collect::<Vec<_>>().join(", ")
    )));
  }

  let mut relation_tables = Vec::new();
  let mut table_names = Vec::with_capacity(selected.len());
  for schema in &selected {
    let table_name = schema
      .table_name
      .clone()
      .ok_or_else(|| Error::Precondition(format!("Missing content table for {}", schema.uid)))?;
    relation_tables.extend(
      schema
        .attributes
        .iter()
        .filter(|(_, attribute)| is_many_to_many(attribute))
        .map(|(name, _)| many_to_many_table_name(&table_name, name)),
    );
    table_names.push(table_name);
  }

  // Removing every selected type as one unit permits cycles among selected
  // types, while the blocker check above protects unselected types and data.
  // Defer foreign keys while deleting all selected records so cyclic relations
  // do not prevent the cleanup. Drop junction tables before their base tables.
  let mut statements = vec!["PRAGMA defer_foreign_keys = ON".to_string()];
  for schema in &selected {
    if let Some(table_name) = schema.table_name.as_deref() {
      statements.extend(drop_content_type_trigger_statements(schema, table_name));
    }
  }
  statements.extend(
    relation_tables
      .iter()
      .map(|table| format!("DROP TABLE IF EXISTS {}", quote_identifier(table))),
  );
  statements.extend(
    table_names
      .iter()
      .map(|table| format!("DELETE FROM {}", quote_identifier(table))),
  );
  statements.extend(
    table_names
      .iter()
      .map(|table| format!("DROP TABLE {}", quote_identifier(table))),
  );

  let tx_log = conn
    .transaction(move |tx| {
      let mut tx = TransactionRecorder::new(tx);
      for statement in statements {
        tx.execute(statement, ())?;
      }
      tx.rollback()
        .map_err(|err| trailbase_sqlite::Error::Other(err.into()))
    })
    .await?;

  let selected_tables: BTreeSet<_> = table_names.iter().map(String::as_str).collect();
  let mut config = (*state.get_config()).clone();
  let old_config_hash = proto::hash_config(&config);
  config.record_apis.retain(|api| {
    api
      .table_name
      .as_deref()
      .is_none_or(|table_name| !selected_tables.contains(table_name))
  });
  state
    .validate_and_update_config(config, Some(old_config_hash))
    .await?;

  if let Some(tx_log) = tx_log {
    tx_log
      .apply_as_migration(
        &conn,
        state.data_dir().migrations_path().join("main"),
        "content_types_bulk_delete",
      )
      .await?;
  }

  for schema in &selected {
    conn
      .write_query_row(
        format!("DELETE FROM {REGISTRY_TABLE} WHERE uid = ?"),
        trailbase_sqlite::params!(schema.uid.clone()),
      )
      .await?;
  }
  state.rebuild_connection_metadata().await?;
  Ok(Json(DeleteContentTypesResponse {
    uids: selected.into_iter().map(|schema| schema.uid).collect(),
  }))
}
