package app.tasksng.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckBox
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.tasksng.android.logic.Block
import app.tasksng.android.logic.Inline
import app.tasksng.android.logic.parseMarkdown

private fun AnnotatedString.Builder.append(nodes: List<Inline>, link: Color, code: Color) {
    for (n in nodes) when (n) {
        is Inline.Text -> append(n.text)
        is Inline.Strong -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(n.children, link, code) }
        is Inline.Em -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(n.children, link, code) }
        is Inline.Del -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(n.children, link, code) }
        is Inline.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = code)) { append(n.text) }
        is Inline.Link -> withLink(
            LinkAnnotation.Url(n.href, TextLinkStyles(SpanStyle(color = link, textDecoration = TextDecoration.Underline))),
        ) { append(n.children, link, code) }
    }
}

@Composable
private fun inline(nodes: List<Inline>): AnnotatedString {
    val link = MaterialTheme.colorScheme.primary
    val code = MaterialTheme.colorScheme.surfaceContainerHigh
    return remember(nodes, link, code) { buildAnnotatedString { append(nodes, link, code) } }
}

@Composable
private fun lines(lines: List<List<Inline>>): AnnotatedString {
    val link = MaterialTheme.colorScheme.primary
    val code = MaterialTheme.colorScheme.surfaceContainerHigh
    return remember(lines, link, code) {
        buildAnnotatedString {
            lines.forEachIndexed { i, l ->
                if (i > 0) append("\n")
                append(l, link, code)
            }
        }
    }
}

@Composable
private fun MarkdownList(list: Block.ListBlock, onToggle: ((Int) -> Unit)?) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        list.items.forEachIndexed { i, item ->
            Row {
                val checked = item.checked
                if (checked != null) {
                    Icon(
                        if (checked) Icons.Default.CheckBox else Icons.Default.CheckBoxOutlineBlank,
                        if (checked) "Done" else "Not done",
                        Modifier.padding(top = 1.dp, end = 8.dp).size(20.dp).clip(RoundedCornerShape(4.dp))
                            .then(if (onToggle != null) Modifier.clickable { onToggle(item.line) } else Modifier),
                        tint = if (checked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text(if (list.ordered) "${list.start + i}." else "•", Modifier.width(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        inline(item.children),
                        color = if (checked == true) MaterialTheme.colorScheme.onSurfaceVariant else Color.Unspecified,
                        textDecoration = if (checked == true) TextDecoration.LineThrough else null,
                    )
                    item.sub?.let { MarkdownList(it, onToggle) }
                }
            }
        }
    }
}

/** Notes as formatted text. [onToggle] gets the source line of a checklist item that was tapped. */
@Composable
fun MarkdownText(source: String, modifier: Modifier = Modifier, onToggle: ((Int) -> Unit)? = null) {
    val blocks = remember(source) { parseMarkdown(source) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (block in blocks) when (block) {
            is Block.Heading -> Text(
                inline(block.children),
                style = when (block.level) {
                    1 -> MaterialTheme.typography.titleLarge
                    2 -> MaterialTheme.typography.titleMedium
                    else -> MaterialTheme.typography.titleSmall
                },
                fontWeight = FontWeight.SemiBold,
            )
            is Block.Paragraph -> Text(lines(block.lines), style = LocalTextStyle.current)
            is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)))
                Spacer(Modifier.width(10.dp))
                Text(lines(block.lines), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            is Block.CodeBlock -> Text(
                block.text,
                Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh)
                    .horizontalScroll(rememberScrollState()).padding(10.dp),
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
            )
            Block.Rule -> HorizontalDivider()
            is Block.ListBlock -> MarkdownList(block, onToggle)
        }
    }
}
