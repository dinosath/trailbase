//! Lightweight Ferris-style content type definitions for the admin API.
//!
//! Content types are backed by regular TrailBase tables. Creating a definition
//! provisions its table and registers a record API, so content remains usable
//! through TrailBase's normal `/api/{pluralName}` endpoints.

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
  #[serde(default)]
  pub computed: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub expression: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub stored: Option<bool>,
  #[serde(default, skip_serializing_if = "Vec::is_empty")]
  pub dependencies: Vec<String>,
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
      if attribute.computed {
        let expression = attribute.expression.as_deref().unwrap_or_default();
        attribute.dependencies = parse_generated_expression(expression)
          .map_err(|err| {
            Error::Precondition(format!("Invalid generated expression for `{name}`: {err}"))
          })?
          .into_iter()
          .collect();
      } else {
        attribute.expression = None;
        attribute.stored = None;
        attribute.dependencies.clear();
      }
      Ok((name, attribute))
    })
    .collect()
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
        || !attribute.dependencies.is_empty())
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
    let mut definition = format!(
      "{} {}",
      quote_identifier(name),
      field_sql_type(&attribute.field_type)?
    );
    if attribute.required && !attribute.computed {
      definition.push_str(" NOT NULL");
    }
    if attribute.unique && !attribute.computed {
      definition.push_str(" UNIQUE");
    }
    if attribute.field_type == "uid" && !attribute.unique && !attribute.computed {
      definition.push_str(" UNIQUE");
    }
    if let Some(default) = &attribute.default {
      if !attribute.computed {
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
    if attribute.computed {
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

async fn relation_table_names(
  conn: &trailbase_sqlite::Connection,
  attributes: &BTreeMap<String, ContentTypeAttribute>,
  own_uid: &str,
  own_table_name: &str,
) -> Result<BTreeMap<String, String>, Error> {
  let mut names = BTreeMap::new();
  for target_uid in attributes
    .values()
    .filter(|attribute| attribute.field_type == "relation")
    .filter_map(|attribute| attribute.relation_target.as_deref())
  {
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
    if attribute.required && !old_schema.attributes.contains_key(source_name) && row_count > 0 {
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
      if attribute.computed {
        continue;
      }
      columns.push(name.clone());
      let source_name = renamed_attributes
        .iter()
        .find_map(|(old, new)| (new == name).then_some(old))
        .unwrap_or(name);
      if old_schema.attributes.contains_key(source_name) {
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
    let tx_log = conn
      .transaction(move |tx| {
        let mut tx = TransactionRecorder::new(tx);
        tx.execute(create_sql, ())?;
        tx.execute(copy_sql, ())?;
        tx.execute(format!("DROP TABLE {old_table}"), ())?;
        tx.execute(rename_sql, ())?;
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
  let drop_sql = format!("DROP TABLE {}", quote_identifier(&table_name));
  let tx_log = conn
    .transaction(move |tx| {
      let mut tx = TransactionRecorder::new(tx);
      tx.execute(drop_sql, ())?;
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
