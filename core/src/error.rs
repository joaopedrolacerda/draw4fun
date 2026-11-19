use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("JSON inválido: {0}")]
    Json(#[from] serde_json::Error),
    #[error("versão do arquivo não suportada: {0} (esta versão lê até {max})", max = crate::SCHEMA_VERSION)]
    UnsupportedSchema(u32),
    #[error("elemento não encontrado: {0}")]
    NotFound(String),
    #[error("o elemento {0} não é do tipo esperado")]
    WrongKind(String),
    #[error("o conteúdo colado não é do draw4fun")]
    NotClipboard,
}
