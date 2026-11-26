//! 数字的写法：Agent 把任务输入解析成 `serde_json::Value`（`executor.rs`）再写成 `task.json`，数字经过它。
//! 控制面认「节点把 secret 值里的数字打印出来」靠的是三端写数字的规则一致，用例表 `testdata/number-form-cases.json`
//! 三端共用：这里断言真实的 `serde_json` 把控制面发来的数字（`sent`）解析再写出就是表里的 `serde`；
//! `cases` 是单个数字，`whole` 是整个值（对象、数组），两部分都断言。**控制面的 `serdeNumber`（`apps/server/src/logs/secrets.ts`）
//! 的规则绑在 `serde_json` 的版本上**：升级后写法变了，这里先红，红了就要改 `serdeNumber` 并更新表里的 `serde` 列。
//! 控制面一端（`apps/server/test/secret-number-forms.test.ts`）和 Python 一端（`sdk/python/tests/test_number_forms.py`）
//! 各断言自己那一段。

use serde_json::Value;

#[test]
fn serde_json_writes_numbers_like_the_shared_table() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../testdata/number-form-cases.json"
    );
    let table: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = table["cases"].as_array().expect("cases 是数组");
    assert!(cases.len() >= 38, "用例表被删空了");
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let sent = case["sent"].as_str().unwrap();
        let serde = case["serde"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(sent).unwrap();
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde,
            "{name}：serde_json 写出的数字和用例表不一致（sent = {sent}）"
        );
    }
}

#[test]
fn serde_json_writes_whole_values_like_the_shared_table() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../testdata/number-form-cases.json"
    );
    let table: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let whole = table["whole"].as_array().expect("whole 是数组");
    assert!(whole.len() >= 4, "用例表的 whole 被删空了");
    for case in whole {
        let name = case["name"].as_str().unwrap();
        let sent = case["sent"].as_str().unwrap();
        let serde = case["serde"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(sent).unwrap();
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde,
            "{name}：serde_json 写出的整个值和用例表不一致（sent = {sent}）"
        );
    }
}
