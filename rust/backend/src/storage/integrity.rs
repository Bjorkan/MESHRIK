//! Explicit FK integrity verification; no unsupported PRAGMA success assumption.
pub struct ForeignKeyViolation {
    pub table: String,
    pub rowid: i64,
    pub parent: String,
    pub id: i64,
}
fn identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

struct ForeignKeyPart {
    sequence: i64,
    parent: String,
    child: String,
    target: Option<String>,
}

pub async fn foreign_key_check(
    connection: &turso::Connection,
) -> turso::Result<Vec<ForeignKeyViolation>> {
    use std::collections::BTreeMap;
    let mut tables = connection.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", ()).await?;
    let mut names = vec![];
    while let Some(row) = tables.next().await? {
        names.push(row.get::<String>(0)?);
    }
    drop(tables);
    let mut failures = vec![];
    for table in names {
        let mut keys = connection
            .query(
                format!("PRAGMA foreign_key_list({})", identifier(&table)),
                (),
            )
            .await?;
        let mut groups: BTreeMap<i64, Vec<ForeignKeyPart>> = BTreeMap::new();
        while let Some(row) = keys.next().await? {
            let target = match row.get_value(4)? {
                turso::Value::Null => None,
                turso::Value::Text(value) if !value.is_empty() => Some(value),
                turso::Value::Text(_) => None,
                _ => return Err(turso::Error::Misuse("Invalid foreign key metadata".into())),
            };
            groups
                .entry(row.get::<i64>(0)?)
                .or_default()
                .push(ForeignKeyPart {
                    sequence: row.get(1)?,
                    parent: row.get(2)?,
                    child: row.get(3)?,
                    target,
                });
        }
        drop(keys);
        for (id, mut parts) in groups {
            parts.sort_by_key(|part| part.sequence);
            let parent = parts[0].parent.clone();
            let mut info = connection
                .query(format!("PRAGMA table_info({})", identifier(&parent)), ())
                .await?;
            let mut primary_key = vec![];
            while let Some(row) = info.next().await? {
                let order = row.get::<i64>(5)?;
                if order > 0 {
                    primary_key.push((order, row.get::<String>(1)?));
                }
            }
            drop(info);
            primary_key.sort_by_key(|item| item.0);
            let mut joins = vec![];
            let mut not_null = vec![];
            let mut first_parent = None;
            for part in parts {
                let target = part
                    .target
                    .or_else(|| {
                        primary_key
                            .get(part.sequence as usize)
                            .map(|item| item.1.clone())
                    })
                    .ok_or_else(|| turso::Error::Misuse("Missing referenced primary key".into()))?;
                joins.push(format!(
                    "p.{} = c.{}",
                    identifier(&target),
                    identifier(&part.child)
                ));
                not_null.push(format!("c.{} IS NOT NULL", identifier(&part.child)));
                first_parent.get_or_insert(target);
            }
            let sql = format!(
                "SELECT c.rowid FROM {} c LEFT JOIN {} p ON {} WHERE {} AND p.{} IS NULL ORDER BY c.rowid",
                identifier(&table),
                identifier(&parent),
                joins.join(" AND "),
                not_null.join(" AND "),
                identifier(first_parent.as_ref().expect("nonempty FK"))
            );
            let mut rows = connection.query(sql, ()).await?;
            while let Some(row) = rows.next().await? {
                failures.push((table.clone(), row.get::<i64>(0)?, parent.clone(), id));
            }
        }
    }
    failures.sort();
    Ok(failures
        .into_iter()
        .map(|(table, rowid, parent, id)| ForeignKeyViolation {
            table,
            rowid,
            parent,
            id,
        })
        .collect())
}
