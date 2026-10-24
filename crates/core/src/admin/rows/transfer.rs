use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use trailbase_schema::db::sqlite::ColumnDataType;
use trailbase_schema::db::{QualifiedName, QualifiedNameEscaped};
use trailbase_sqlvalue::SqlValue;

use crate::admin::AdminError as Error;
use crate::app_state::AppState;
use crate::connection::ConnectionEntry;
use crate::records::params::InsertParams;
use crate::records::write_queries::run_insert_or_replace_query;
use crate::util::row_id_column;

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ImportTableRequest {
  records: Vec<indexmap::IndexMap<String, Value>>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ImportTableResponse {
  imported_count: usize,
}

#[derive(Debug, Deserialize)]
pub struct ExportTableQuery {
  format: Option<String>,
}

#[utoipa::path(
  get,
  path = "/table/{table_name}/export",
  tag = "admin",
  params(("format" = Option<String>, Query, description = "json or csv")),
  responses((status = 200, description = "Serialized table records"))
)]
pub async fn export_table_handler(
  State(state): State<AppState>,
  Path(table_name): Path<String>,
  Query(query): Query<ExportTableQuery>,
) -> Result<Response, Error> {
  let format = query.format.as_deref().unwrap_or("json");
  if format != "json" && format != "csv" && format != "yaml" {
    return Err(Error::BadRequest(
      "format must be json, yaml, or csv".into(),
    ));
  }

  let qualified_name = QualifiedName::parse(&table_name)?;
  let ConnectionEntry {
    connection: conn,
    metadata,
  } = state
    .connection_manager()
    .get_entry_for_qn(&qualified_name)
    .await?;
  let Some(table) = metadata.get_table(&qualified_name) else {
    return Err(Error::Precondition(format!(
      "Table {qualified_name:?} not found"
    )));
  };

  let query = format!(
    "SELECT * FROM {}",
    QualifiedNameEscaped::new(&table.schema.name)
  );
  let result_rows = conn.read_query_rows(query, ()).await?;
  let columns = table.schema.columns.clone();
  let rows = crate::admin::util::rows_to_sql_value_rows(result_rows)?;
  let body = match format {
    "json" | "yaml" => {
      let records: Vec<serde_json::Map<String, Value>> = rows
        .into_iter()
        .map(|row| {
          columns
            .iter()
            .zip(row)
            .map(|(column, value)| (column.name.clone(), sql_value_to_json(value)))
            .collect()
        })
        .collect();
      if format == "yaml" {
        serde_yaml::to_string(&records)
          .map_err(|err| Error::Internal(err.into()))?
          .into_bytes()
      } else {
        let mut body = serde_json::to_vec_pretty(&records)?;
        body.push(b'\n');
        body
      }
    }
    _ => {
      let mut body = Vec::new();
      body.extend(
        columns
          .iter()
          .map(|column| csv_cell(&column.name))
          .collect::<Vec<_>>()
          .join(",")
          .as_bytes(),
      );
      body.push(b'\n');
      for row in rows {
        let line = columns
          .iter()
          .zip(row)
          .map(|(_, value)| csv_cell(&sql_value_to_csv(value)))
          .collect::<Vec<_>>()
          .join(",");
        body.extend(line.as_bytes());
        body.push(b'\n');
      }
      body
    }
  };

  let filename = format!("{}.{}", qualified_name.name, format);
  Response::builder()
    .status(StatusCode::OK)
    .header(
      header::CONTENT_TYPE,
      match format {
        "json" => "application/json; charset=utf-8",
        "yaml" => "application/yaml; charset=utf-8",
        _ => "text/csv; charset=utf-8",
      },
    )
    .header(
      header::CONTENT_DISPOSITION,
      format!("attachment; filename=\"{filename}\""),
    )
    .body(Body::from(body))
    .map_err(|err| Error::Internal(err.into()))
}

#[utoipa::path(
  post,
  path = "/table/{table_name}/import",
  tag = "admin",
  request_body = ImportTableRequest,
  responses((status = 200, description = "Records imported", body = ImportTableResponse))
)]
pub async fn import_table_handler(
  State(state): State<AppState>,
  Path(table_name): Path<String>,
  Json(request): Json<ImportTableRequest>,
) -> Result<Json<ImportTableResponse>, Error> {
  let qualified_name = QualifiedName::parse(&table_name)?;
  let ConnectionEntry {
    connection: conn,
    metadata,
  } = state
    .connection_manager()
    .get_entry_for_qn(&qualified_name)
    .await?;
  let Some(table_metadata) = metadata.get_table(&qualified_name) else {
    return Err(Error::Precondition(format!(
      "Table {qualified_name:?} not found"
    )));
  };

  let mut imported_count = 0;
  for record in request.records {
    let row = record
      .into_iter()
      .map(|(name, value)| {
        let column = table_metadata
          .column_by_name(&name)
          .ok_or_else(|| Error::BadRequest(format!("Unknown column: {name}").into()))?;
        Ok((name, json_to_sql_value(value, column.column.data_type)?))
      })
      .collect::<Result<indexmap::IndexMap<_, _>, Error>>()?;

    let params = InsertParams::for_admin_insert(table_metadata, row)?;
    run_insert_or_replace_query(
      &conn,
      state.objectstore(),
      &QualifiedNameEscaped::new(&table_metadata.schema.name),
      &table_metadata.column_metadata,
      crate::config::proto::ConflictResolutionStrategy::Abort,
      row_id_column(conn.connection_type()),
      Arc::new(params),
      /* files= */ vec![],
    )
    .await?;
    imported_count += 1;
  }

  Ok(Json(ImportTableResponse { imported_count }))
}

fn sql_value_to_json(value: SqlValue) -> Value {
  match value {
    SqlValue::Null => Value::Null,
    SqlValue::Integer(value) => Value::Number(value.into()),
    SqlValue::Real(value) => serde_json::Number::from_f64(value)
      .map(Value::Number)
      .unwrap_or(Value::Null),
    SqlValue::Text(value) => Value::String(value),
    SqlValue::Blob(value) => serde_json::to_value(value).unwrap_or(Value::Null),
  }
}

fn sql_value_to_csv(value: SqlValue) -> String {
  match value {
    SqlValue::Null => String::new(),
    SqlValue::Integer(value) => value.to_string(),
    SqlValue::Real(value) => value.to_string(),
    SqlValue::Text(value) => value,
    SqlValue::Blob(value) => serde_json::to_string(&value).unwrap_or_default(),
  }
}

fn csv_cell(value: &str) -> String {
  if value.contains([',', '"', '\n', '\r']) {
    format!("\"{}\"", value.replace('"', "\"\""))
  } else {
    value.to_string()
  }
}

fn json_to_sql_value(value: Value, data_type: ColumnDataType) -> Result<SqlValue, Error> {
  let converted = match value {
    Value::Null => SqlValue::Null,
    Value::Bool(value) => SqlValue::Integer(i64::from(value)),
    Value::Number(value) => {
      if let Some(value) = value.as_i64() {
        SqlValue::Integer(value)
      } else if let Some(value) = value.as_f64() {
        SqlValue::Real(value)
      } else {
        return Err(Error::BadRequest(
          "Number is outside the supported range".into(),
        ));
      }
    }
    Value::String(value) => {
      if value.is_empty()
        && matches!(
          data_type,
          ColumnDataType::Integer | ColumnDataType::Real | ColumnDataType::Blob
        )
      {
        SqlValue::Null
      } else {
        SqlValue::Text(value)
      }
    }
    value @ (Value::Array(_) | Value::Object(_)) => SqlValue::Text(serde_json::to_string(&value)?),
  };
  Ok(converted)
}
